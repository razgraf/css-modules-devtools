import fs from "node:fs";
import path from "node:path";
import { defaultSettings, diskSource, Project, type Settings } from "@css-modules-devtools/core";
import {
	CodeActionKind,
	type Connection,
	createConnection,
	DiagnosticRefreshRequest,
	DocumentDiagnosticReportKind,
	FileChangeType,
	ProposedFeatures,
	TextDocumentSyncKind,
	TextDocuments,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { defaultEnvironment, docParams, type Environment, FeatureContext } from "./context";
import { isCss, toPath } from "./lsp";
import * as router from "./router";

export interface Configuration {
	settings: Settings;
	env: Environment;
}

export const CONFIGURE_NOTIFICATION = "cssModulesDevTools/configure";

const TRIGGERS = [".", "[", '"', "'", "`", "-", "(", " ", "{", ",", "/", "@"];

/** Coalesces bursts of keystrokes and watcher events into one workspace-wide diagnostics pull. */
export const REFRESH_DELAY = 150;

/** Dependency, VCS and framework cache folders, which the module walker and globs never read either. */
const IGNORED_DIRS = new Set(["node_modules", ".next", ".turbo", ".git"]);

const CONFIG_RE = /^(?:(?:ts|js)config[^/\\]*\.json|package\.json)$/;

/**
 * Whether a change can alter what we index: any config event, and creates/deletes of stylesheets and folders. The catch-all watcher
 * reports every file, so an unrelated `.ts` or image must not wipe the caches.
 */
export function isStructural(file: string, type: FileChangeType, indexed: string[]): boolean {
	if (CONFIG_RE.test(path.basename(file))) return true;
	if (type === FileChangeType.Changed) return false;
	if (isCss(file)) return true;
	if (type === FileChangeType.Created) {
		try {
			return fs.statSync(file).isDirectory();
		} catch {
			return false;
		}
	}
	const dir = file + path.sep;
	return indexed.some((f) => f.startsWith(dir));
}

/** Whether `file` sits in an ignored folder, judged only by the segments below its workspace folder. */
export function isIgnoredChange(file: string, workspaceFolders: string[]): boolean {
	const folder = workspaceFolders.find((dir) => file === dir || file.startsWith(dir + path.sep));
	const rel = folder ? path.relative(folder, file) : file;
	return rel.split(/[\\/]/).some((segment) => IGNORED_DIRS.has(segment));
}

/**
 * Open documents keyed by decoded file path. VS Code escapes URIs differently from `pathToFileURL`
 * (`@`, `+`, `(`, `)`…), so the project's path-based reads can't look documents up by a re-encoded URI.
 */
export class OpenFiles {
	private readonly docs = new Map<string, TextDocument>();

	set(doc: TextDocument) {
		this.docs.set(toPath(doc.uri), doc);
	}

	delete(uri: string) {
		this.docs.delete(toPath(uri));
	}

	text(file: string): string | undefined {
		return this.docs.get(file)?.getText();
	}
}

export function startServer(connection: Connection = createConnection(ProposedFeatures.all)) {
	const documents = new TextDocuments(TextDocument);
	const open = new OpenFiles();
	const project = new Project({
		read: (file) => open.text(file) ?? diskSource.read(file),
	});
	const ctx = new FeatureContext(project);
	let workspaceFolders: string[] = [];
	let canRefresh = false;
	let foldersSupported = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;

	const refresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = undefined;
		if (!canRefresh) return;
		connection.sendRequest(DiagnosticRefreshRequest.type).catch((error: unknown) => {
			connection.console.error(`diagnostics refresh: ${error instanceof Error ? error.message : error}`);
		});
	};

	const scheduleRefresh = () => {
		clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refresh, REFRESH_DELAY);
	};

	const configure = (config: Partial<Configuration> | undefined) => {
		project.configure(config?.settings ?? defaultSettings, workspaceFolders);
		ctx.env = config?.env ?? defaultEnvironment;
		ctx.reset();
		refresh();
	};

	connection.onInitialize((params) => {
		workspaceFolders = (params.workspaceFolders ?? []).map((f) => toPath(f.uri));
		canRefresh = params.capabilities.workspace?.diagnostics?.refreshSupport === true;
		foldersSupported = params.capabilities.workspace?.workspaceFolders === true;
		const config = params.initializationOptions as Partial<Configuration> | undefined;
		project.configure(config?.settings ?? defaultSettings, workspaceFolders);
		ctx.env = config?.env ?? defaultEnvironment;
		return {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
				completionProvider: { triggerCharacters: TRIGGERS, resolveProvider: true },
				definitionProvider: true,
				hoverProvider: true,
				codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
				colorProvider: true,
				diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
				workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
			},
		};
	});

	connection.onInitialized(() => {
		if (!foldersSupported) return;
		connection.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
			const gone = new Set(removed.map((f) => toPath(f.uri)));
			workspaceFolders = [
				...new Set([...workspaceFolders.filter((f) => !gone.has(f)), ...added.map((f) => toPath(f.uri))]),
			];
			project.configure(project.settings, workspaceFolders);
			ctx.reset();
			refresh();
		});
	});

	connection.onNotification(CONFIGURE_NOTIFICATION, (config: Configuration) => configure(config));

	// Invalidation is a cheap cache delete and must happen before the next request reads the file;
	// only the workspace-wide re-pull is deferred.
	documents.onDidChangeContent(({ document }) => {
		const file = toPath(document.uri);
		open.set(document);
		project.invalidate(file);
		if (isCss(file)) scheduleRefresh();
	});
	documents.onDidClose(({ document }) => {
		const file = toPath(document.uri);
		open.delete(document.uri);
		project.invalidate(file);
		if (isCss(file)) scheduleRefresh();
	});

	connection.onDidChangeWatchedFiles(({ changes }) => {
		let edited = false;
		const structural = new Set<string>();
		for (const change of changes) {
			const file = toPath(change.uri);
			if (change.type === FileChangeType.Changed && isCss(file)) {
				project.invalidate(file);
				edited = true;
			} else if (
				!isIgnoredChange(file, workspaceFolders) &&
				isStructural(file, change.type, project.indexedFiles())
			) {
				structural.add(file);
			}
		}
		if (structural.size > 0) {
			// A deleted or renamed folder arrives as a single event for the folder itself.
			const dirs = [...structural].map((file) => file + path.sep);
			const nested = project.indexedFiles().filter((file) => dirs.some((dir) => file.startsWith(dir)));
			project.filesChanged([...structural, ...nested]);
			ctx.reset();
		}
		if (edited || structural.size > 0) scheduleRefresh();
	});
	connection.onShutdown(() => clearTimeout(refreshTimer));

	const withDoc = <T>(uri: string, fallback: T, fn: (doc: TextDocument) => T): T => {
		const doc = documents.get(uri);
		if (!doc) return fallback;
		try {
			return fn(doc);
		} catch (error) {
			connection.console.error(`${uri}: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
			return fallback;
		}
	};

	connection.onCompletion(({ textDocument, position }) =>
		withDoc(textDocument.uri, [], (doc) => router.completion(docParams(ctx, doc, position))),
	);
	connection.onCompletionResolve((item) => {
		try {
			return router.resolveCompletion(ctx, item);
		} catch (error) {
			connection.console.error(
				`resolve ${item.label}: ${error instanceof Error ? (error.stack ?? error.message) : error}`,
			);
			return item;
		}
	});
	connection.onDefinition(({ textDocument, position }) =>
		withDoc(textDocument.uri, undefined, (doc) => router.definition(docParams(ctx, doc, position))),
	);
	connection.onHover(({ textDocument, position }) =>
		withDoc(textDocument.uri, undefined, (doc) => router.hover(docParams(ctx, doc, position))),
	);
	connection.onCodeAction((params) =>
		withDoc(params.textDocument.uri, [], (doc) =>
			router.codeActions(docParams(ctx, doc, params.range.start), params),
		),
	);
	connection.onDocumentColor(({ textDocument }) =>
		withDoc(textDocument.uri, [], (doc) => router.colors(docParams(ctx, doc))),
	);
	// Swatches are read-only: the picker never rewrites a `var()` reference.
	connection.onColorPresentation(() => []);
	connection.languages.diagnostics.on(({ textDocument }) => ({
		kind: DocumentDiagnosticReportKind.Full,
		items: withDoc(textDocument.uri, [], (doc) => router.diagnostics(docParams(ctx, doc))),
	}));

	documents.listen(connection);
	connection.listen();
	return { connection, documents, project, ctx };
}
