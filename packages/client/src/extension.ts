import * as vscode from "vscode";
import {
	LanguageClient,
	type LanguageClientOptions,
	type ServerOptions,
	State,
	TransportKind,
} from "vscode-languageclient/node";
import { buildConfiguration, CONFIGURE_NOTIFICATION, type Reader, setting, WATCHED_SECTIONS } from "./config";

/** Extensions whose features overlap ours; users get a one-time notice per extension. */
const OVERLAPPING = ["clinyong.vscode-css-modules", "vunguyentuan.vscode-css-variables"];
const LANGUAGES = ["css", "typescriptreact", "typescript", "javascriptreact", "javascript"];

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const serverModule = context.asAbsolutePath("dist/server.js");
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ["--nolazy", "--inspect=6009"] },
		},
	};
	const watchers = [
		vscode.workspace.createFileSystemWatcher("**/{*.css,tsconfig*.json,jsconfig*.json,package.json}"),
		// Deleting or renaming a folder reports only the folder, which the stylesheet glob never matches.
		vscode.workspace.createFileSystemWatcher("**/*", false, true, false),
	];
	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			...LANGUAGES.map((language) => ({ scheme: "file", language })),
			// PostCSS Language Support (csstools.postcss) claims `.css` for its `postcss` language.
			{ scheme: "file", language: "postcss", pattern: "**/*.css" },
		],
		synchronize: { fileEvents: watchers },
		initializationOptions: configuration(),
	};
	client = new LanguageClient("cssModulesDevTools", "CSS Modules DevTools", serverOptions, clientOptions);
	context.subscriptions.push(...watchers);

	const reconfigure = () => {
		if (!client || client.state === State.Stopped) return;
		client.sendNotification(CONFIGURE_NOTIFICATION, configuration()).catch((error: unknown) => {
			client?.error("Failed to send configuration", error);
		});
	};
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (WATCHED_SECTIONS.some((section) => event.affectsConfiguration(section))) reconfigure();
		}),
		// Restricted settings (ours and the fallbacks in `setting`) take their workspace values once trusted.
		vscode.workspace.onDidGrantWorkspaceTrust(reconfigure),
		vscode.extensions.onDidChange(() => {
			reconfigure();
			void noticeOverlaps(context);
		}),
	);

	void noticeOverlaps(context);
	await client.start();
}

export async function deactivate(): Promise<void> {
	await client?.stop();
	client = undefined;
}

function configuration() {
	return buildConfiguration(read, (id) => vscode.extensions.getExtension(id) !== undefined);
}

const read: Reader = (section, key) => {
	const config = vscode.workspace.getConfiguration(section);
	return setting(`${section}.${key}`, config.get(key), config.inspect(key), vscode.workspace.isTrusted);
};

async function noticeOverlaps(context: vscode.ExtensionContext): Promise<void> {
	for (const id of OVERLAPPING) {
		const extension = vscode.extensions.getExtension(id);
		const flag = `notice.overlap.${id}`;
		if (!extension || context.globalState.get<boolean>(flag)) continue;
		await context.globalState.update(flag, true);
		const name = displayName(extension) ?? id;
		const action = await vscode.window.showInformationMessage(
			`CSS Modules DevTools covers what ${name} does. Running both shows duplicate completions and hovers; consider disabling ${name}.`,
			"Show extension",
		);
		if (action === "Show extension") await showExtension(id);
	}
}

function displayName(extension: vscode.Extension<unknown>): string | undefined {
	const manifest: unknown = extension.packageJSON;
	if (typeof manifest !== "object" || manifest === null || !("displayName" in manifest)) return undefined;
	return typeof manifest.displayName === "string" ? manifest.displayName : undefined;
}

async function showExtension(id: string): Promise<void> {
	try {
		await vscode.commands.executeCommand("extension.open", id);
	} catch {
		await vscode.commands.executeCommand("workbench.extensions.search", `@id:${id}`);
	}
}
