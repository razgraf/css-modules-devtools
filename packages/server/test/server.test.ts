import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
	type CompletionItem,
	CompletionRequest,
	CompletionResolveRequest,
	type Connection,
	createConnection,
	createProtocolConnection,
	DiagnosticRefreshRequest,
	DidChangeTextDocumentNotification,
	DidChangeWatchedFilesNotification,
	DidChangeWorkspaceFoldersNotification,
	DidCloseTextDocumentNotification,
	DidOpenTextDocumentNotification,
	FileChangeType,
	InitializedNotification,
	InitializeRequest,
	type InitializeResult,
	type ProtocolConnection,
	ShutdownRequest,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toPath } from "../src/lsp";
import { isIgnoredChange, isStructural, OpenFiles, REFRESH_DELAY, startServer } from "../src/server";

/** How VS Code (`vscode-uri`) serialises a file path: every byte outside RFC 3986 "unreserved" is escaped. */
const vscodeUri = (file: string) =>
	`file://${file
		.split("/")
		.map((segment) =>
			segment.replace(
				/[^A-Za-z0-9\-._~]/g,
				(c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
			),
		)
		.join("/")}`;

describe("toPath", () => {
	test("decodes VS Code escapes", () => {
		expect(toPath("file:///Users/me/%40scope/my%20app/a%2Bb%28c%29.module.css")).toBe(
			"/Users/me/@scope/my app/a+b(c).module.css",
		);
	});

	test("leaves non-file URIs untouched", () => {
		expect(toPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
	});
});

describe("OpenFiles", () => {
	const file = "/Users/me/@scope/my app/(group)/a+b.module.css";

	test("finds a document opened under a VS Code-encoded URI by its plain path", () => {
		const open = new OpenFiles();
		open.set(TextDocument.create(vscodeUri(file), "css", 1, ".fresh {}"));
		expect(open.text(file)).toBe(".fresh {}");
	});

	test("forgets closed documents", () => {
		const open = new OpenFiles();
		const uri = vscodeUri(file);
		open.set(TextDocument.create(uri, "css", 1, ".fresh {}"));
		open.delete(uri);
		expect(open.text(file)).toBeUndefined();
	});
});

async function waitFor(condition: () => boolean, timeout = 2000) {
	const deadline = Date.now() + timeout;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

describe("isIgnoredChange", () => {
	const folder = "/x/build/app";

	test("judges only segments below the workspace folder", () => {
		expect(isIgnoredChange("/x/build/app/src/a.module.css", [folder])).toBe(false);
		expect(isIgnoredChange("/x/build/app/src/outline", [folder])).toBe(false);
		expect(isIgnoredChange(folder, [folder])).toBe(false);
	});

	test("ignores dependency, framework cache and VCS folders", () => {
		for (const dir of ["node_modules", ".next", ".turbo", ".git"]) {
			expect(isIgnoredChange(`/x/build/app/${dir}`, [folder])).toBe(true);
			expect(isIgnoredChange(`/x/build/app/packages/ui/${dir}/a.css`, [folder])).toBe(true);
		}
	});

	test("checks every segment outside the workspace folders", () => {
		expect(isIgnoredChange("/y/node_modules/p/a.css", [folder])).toBe(true);
		expect(isIgnoredChange("/y/src/a.css", [folder])).toBe(false);
	});

	test("keeps generic folder names the module walker also reads", () => {
		for (const dir of ["dist", "build", "out"]) {
			expect(isIgnoredChange(`/x/build/app/src/${dir}/a.module.css`, [folder])).toBe(false);
		}
	});
});

describe("isStructural", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-structural-"));
	fs.mkdirSync(path.join(tmp, "styles"));

	test("stylesheets and configs always count", () => {
		for (const name of [
			"a.module.css",
			"g.css",
			"tsconfig.json",
			"tsconfig.app.json",
			"jsconfig.json",
			"package.json",
		]) {
			expect(isStructural(path.join(tmp, name), FileChangeType.Deleted, [])).toBe(true);
		}
	});

	test("config edits count; other edits don't", () => {
		expect(isStructural(path.join(tmp, "tsconfig.json"), FileChangeType.Changed, [])).toBe(true);
		expect(isStructural(path.join(tmp, "a.module.css"), FileChangeType.Changed, [])).toBe(false);
	});

	test("unrelated files don't", () => {
		expect(isStructural(path.join(tmp, "Button.tsx"), FileChangeType.Created, [])).toBe(false);
		expect(isStructural(path.join(tmp, "logo.png"), FileChangeType.Deleted, [])).toBe(false);
	});

	test("a created folder counts; a deleted one only when it held indexed files", () => {
		expect(isStructural(path.join(tmp, "styles"), FileChangeType.Created, [])).toBe(true);
		const gone = path.join(tmp, "gone");
		expect(isStructural(gone, FileChangeType.Deleted, [])).toBe(false);
		expect(isStructural(gone, FileChangeType.Deleted, [path.join(gone, "a.module.css")])).toBe(true);
	});
});

describe("server over a VS Code-encoded workspace path", () => {
	let tmp: string;
	let root: string;
	let css: string;
	let app: string;
	let client: ProtocolConnection;
	let server: Connection;
	let project: ReturnType<typeof startServer>["project"];
	let init: InitializeResult;
	let refreshes = 0;

	const APP = 'import styles from "./a.module.css";\n\nexport const A = () => <div className={styles.} />;\n';
	const cursor = { line: 2, character: (APP.split("\n")[2] ?? "").indexOf("styles.") + "styles.".length };

	const complete = async (): Promise<CompletionItem[]> => {
		const items = await client.sendRequest(CompletionRequest.type, {
			textDocument: { uri: vscodeUri(app) },
			position: cursor,
		});
		return Array.isArray(items) ? items : (items?.items ?? []);
	};
	const labels = async () => (await complete()).map((i) => i.label).sort();

	beforeAll(async () => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-server-")));
		root = path.join(tmp, "@scope", "my app (x+y)");
		fs.mkdirSync(path.join(root, "src"), { recursive: true });
		css = path.join(root, "src", "a.module.css");
		app = path.join(root, "src", "App.tsx");
		fs.writeFileSync(css, ".stale {}\n");
		fs.writeFileSync(app, APP);

		const up = new PassThrough();
		const down = new PassThrough();
		({ connection: server, project } = startServer(
			createConnection(new StreamMessageReader(up), new StreamMessageWriter(down)),
		));
		client = createProtocolConnection(new StreamMessageReader(down), new StreamMessageWriter(up));
		client.onRequest(DiagnosticRefreshRequest.type, () => {
			refreshes++;
		});
		client.listen();

		init = await client.sendRequest(InitializeRequest.type, {
			processId: null,
			rootUri: vscodeUri(root),
			workspaceFolders: [{ uri: vscodeUri(root), name: "app" }],
			capabilities: { workspace: { diagnostics: { refreshSupport: true }, workspaceFolders: true } },
		});
		await client.sendNotification(InitializedNotification.type, {});
	});

	afterAll(async () => {
		await client.sendRequest(ShutdownRequest.type);
		// No `exit` notification: the server answers it with `process.exit()`, which would end the test run.
		client.dispose();
		server.dispose();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	test("completion reads an open stylesheet's unsaved text, not the disk", async () => {
		await client.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: { uri: vscodeUri(css), languageId: "css", version: 1, text: ".fresh {}\n" },
		});
		await client.sendNotification(DidOpenTextDocumentNotification.type, {
			textDocument: { uri: vscodeUri(app), languageId: "typescriptreact", version: 1, text: APP },
		});
		expect(await labels()).toEqual(["fresh"]);
	});

	test("edits reach completion immediately; the diagnostics refresh is debounced", async () => {
		refreshes = 0;
		for (let version = 2; version <= 6; version++) {
			await client.sendNotification(DidChangeTextDocumentNotification.type, {
				textDocument: { uri: vscodeUri(css), version },
				contentChanges: [{ text: `.fresh {}\n.typed${version} {}\n` }],
			});
		}
		expect(await labels()).toEqual(["fresh", "typed6"]);
		expect(refreshes).toBe(0);
		await waitFor(() => refreshes === 1);
		await Bun.sleep(REFRESH_DELAY);
		expect(refreshes).toBe(1);
	});

	test("closing a stylesheet falls back to the disk", async () => {
		await client.sendNotification(DidCloseTextDocumentNotification.type, {
			textDocument: { uri: vscodeUri(css) },
		});
		expect(await labels()).toEqual(["stale"]);
	});

	test("advertises and answers completion resolve", async () => {
		expect(init.capabilities.completionProvider?.resolveProvider).toBe(true);
		const [item] = await complete();
		expect(item?.label).toBe("stale");
		expect(item?.documentation).toBeUndefined();
		if (!item) return;
		const resolved = await client.sendRequest(CompletionResolveRequest.type, item);
		expect(resolved.label).toBe("stale");
		expect(resolved.documentation).toMatchObject({
			kind: "markdown",
			value: expect.stringContaining(".stale {"),
		});
	});

	test("follows workspace folder changes", async () => {
		expect(init.capabilities.workspace?.workspaceFolders).toEqual({
			supported: true,
			changeNotifications: true,
		});
		const extra = path.join(tmp, "extra");
		await client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
			event: { added: [{ uri: vscodeUri(extra), name: "extra" }], removed: [] },
		});
		await complete();
		expect(project.workspaceFolders).toEqual([root, extra]);
		await client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
			event: { added: [], removed: [{ uri: vscodeUri(extra), name: "extra" }] },
		});
		await complete();
		expect(project.workspaceFolders).toEqual([root]);
	});

	test("a deleted folder invalidates the stylesheets parsed inside it", async () => {
		const dir = path.join(root, "src", "sub");
		const nested = path.join(dir, "b.module.css");
		fs.mkdirSync(dir);
		fs.writeFileSync(nested, ".b {}\n");
		project.cssInfo(nested);
		fs.rmSync(dir, { recursive: true });
		const filesChanged = spyOn(project, "filesChanged");
		try {
			await client.sendNotification(DidChangeWatchedFilesNotification.type, {
				changes: [{ uri: vscodeUri(dir), type: FileChangeType.Deleted }],
			});
			await complete();
			expect(filesChanged).toHaveBeenCalledTimes(1);
			expect(filesChanged).toHaveBeenCalledWith([dir, nested]);
		} finally {
			filesChanged.mockRestore();
		}
	});

	test("config changes are structural; churn in ignored folders is not", async () => {
		const filesChanged = spyOn(project, "filesChanged");
		try {
			await client.sendNotification(DidChangeWatchedFilesNotification.type, {
				changes: [
					{ uri: vscodeUri(path.join(root, "node_modules", "pkg", "a.css")), type: FileChangeType.Created },
					{ uri: vscodeUri(path.join(root, "dist")), type: FileChangeType.Deleted },
				],
			});
			await complete();
			expect(filesChanged).not.toHaveBeenCalled();

			const tsconfig = path.join(root, "tsconfig.json");
			await client.sendNotification(DidChangeWatchedFilesNotification.type, {
				changes: [{ uri: vscodeUri(tsconfig), type: FileChangeType.Changed }],
			});
			await complete();
			expect(filesChanged).toHaveBeenCalledTimes(1);
			expect(filesChanged).toHaveBeenCalledWith([tsconfig]);
		} finally {
			filesChanged.mockRestore();
		}
	});
});
