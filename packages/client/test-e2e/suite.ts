import assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "razgraf.css-modules-devtools";
const SOURCE = "css-modules-devtools";

type Test = [name: string, fn: () => Promise<void>];

const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

let folder: vscode.WorkspaceFolder;
let doc: vscode.TextDocument;

function positionIn(document: vscode.TextDocument, needle: string, delta = 0): vscode.Position {
	const index = document.getText().indexOf(needle);
	assert.ok(index >= 0, `"${needle}" not found in ${document.uri.fsPath}`);
	return document.positionAt(index + delta);
}

const positionOf = (needle: string, delta = 0) => positionIn(doc, needle, delta);

async function show(relative: string): Promise<vscode.TextDocument> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, relative));
	await vscode.window.showTextDocument(document);
	return document;
}

async function revert(document: vscode.TextDocument): Promise<void> {
	await vscode.window.showTextDocument(document);
	await vscode.commands.executeCommand("workbench.action.files.revert");
}

const ownDiagnostics = (uri: vscode.Uri) =>
	vscode.languages.getDiagnostics(uri).filter((item) => item.source === SOURCE);

async function poll<T>(probe: () => Promise<T | undefined> | T | undefined, timeout = 10_000): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await probe();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Timed out after ${timeout} ms`);
}

function hoverText(hover: vscode.Hover): string {
	return hover.contents.map((content) => (typeof content === "string" ? content : content.value)).join("\n");
}

function targetPath(location: vscode.Location | vscode.LocationLink): string {
	return "targetUri" in location ? location.targetUri.fsPath : location.uri.fsPath;
}

test("extension activates", async () => {
	const extension = vscode.extensions.getExtension(EXTENSION_ID);
	assert.ok(extension, `${EXTENSION_ID} not found`);
	await extension.activate();
	assert.equal(extension.isActive, true);
});

const labelOf = (item: vscode.CompletionItem) =>
	typeof item.label === "string" ? item.label : item.label.label;

const descriptionOf = (item: vscode.CompletionItem) =>
	typeof item.label === "string" ? undefined : item.label.description;

function completionsAt(
	uri: vscode.Uri,
	position: vscode.Position,
	trigger?: string,
	resolveCount?: number,
): Thenable<vscode.CompletionList> {
	return vscode.commands.executeCommand<vscode.CompletionList>(
		"vscode.executeCompletionItemProvider",
		uri,
		position,
		trigger,
		resolveCount,
	);
}

const completions = (position: vscode.Position, resolveCount?: number) =>
	completionsAt(doc.uri, position, ".", resolveCount);

function definitions(uri: vscode.Uri, position: vscode.Position) {
	return vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
		"vscode.executeDefinitionProvider",
		uri,
		position,
	);
}

function targetRange(location: vscode.Location | vscode.LocationLink): vscode.Range {
	return "targetUri" in location ? (location.targetSelectionRange ?? location.targetRange) : location.range;
}

async function completionLabels(position: vscode.Position, expected = "button"): Promise<string[]> {
	return poll(async () => {
		const labels = (await completions(position)).items.map(labelOf);
		return labels.includes(expected) ? labels : undefined;
	});
}

test("completion after `styles.` offers module classes", async () => {
	const labels = await completionLabels(positionOf("styles.icon", "styles.".length));
	assert.ok(labels.includes("button"));
});

test("completion inside a template literal substitution", async () => {
	const labels = await completionLabels(positionOf("${styles.button}", "${styles.".length));
	assert.ok(labels.includes("icon"));
});

test("resolving a class completion fills in its rule as documentation", async () => {
	const position = positionOf("styles.icon", "styles.".length);
	const unresolved = await poll(async () =>
		(await completions(position)).items.find((item) => labelOf(item) === "button"),
	);
	assert.equal(unresolved.documentation, undefined, "documentation should be deferred to resolve");
	// VS Code resolves the first `itemResolveCount` items in list order, which is not alphabetical.
	const resolved = await poll(async () => {
		const list = await completions(position, 1000);
		return list.items.find((item) => labelOf(item) === "button" && item.documentation !== undefined);
	});
	const { documentation } = resolved;
	const text = typeof documentation === "string" ? documentation : documentation?.value;
	assert.match(text ?? "", /\.button\s*\{/);
});

test("hover on `styles.button` shows its rules", async () => {
	const position = positionOf("styles.button", "styles.b".length);
	const text = await poll(async () => {
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			"vscode.executeHoverProvider",
			doc.uri,
			position,
		);
		const text = hovers.map(hoverText).join("\n");
		return text.includes(".button") ? text : undefined;
	});
	assert.match(text, /\.button/);
});

test("definition of `styles.button` points to Button.module.css", async () => {
	const position = positionOf("styles.button", "styles.b".length);
	const targets = await poll(async () => {
		const targets = (await definitions(doc.uri, position))
			.map(targetPath)
			.filter((file) => file.endsWith("Button.module.css"));
		return targets.length > 0 ? targets : undefined;
	});
	assert.ok(targets.length > 0);
});

test("`styles.missing` is reported", async () => {
	const range = positionOf("styles.missing", "styles.".length);
	const diagnostic = await poll(() =>
		vscode.languages
			.getDiagnostics(doc.uri)
			.find((item) => item.range.contains(range) && /missing/.test(item.message)),
	);
	assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
});

test("settings changes reach the server", async () => {
	const position = positionOf("styles.missing", "styles.".length);
	const missing = () =>
		vscode.languages
			.getDiagnostics(doc.uri)
			.some((item) => item.range.contains(position) && /missing/.test(item.message));
	const config = vscode.workspace.getConfiguration("cssModulesDevTools");
	await config.update("diagnostics", { missingClass: "off" }, vscode.ConfigurationTarget.Global);
	try {
		await poll(() => (missing() ? undefined : true));
	} finally {
		await config.update("diagnostics", undefined, vscode.ConfigurationTarget.Global);
	}
	await poll(() => (missing() ? true : undefined));
});

test("unsaved stylesheet edits reach completion", async () => {
	const position = positionOf("styles.icon", "styles.".length);
	const css = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(doc.uri, "..", "Button.module.css"),
	);
	const edit = new vscode.WorkspaceEdit();
	edit.insert(css.uri, new vscode.Position(0, 0), ".overlayOnly {}\n");
	assert.ok(await vscode.workspace.applyEdit(edit));
	try {
		assert.ok(css.isDirty);
		await completionLabels(position, "overlayOnly");
	} finally {
		await vscode.window.showTextDocument(css);
		await vscode.commands.executeCommand("workbench.action.files.revert");
		await vscode.window.showTextDocument(doc);
	}
	await poll(async () =>
		(await completions(position)).items.some((i) => labelOf(i) === "overlayOnly") ? undefined : true,
	);
});

test("composes completion offers the target module's classes and module paths", async () => {
	const css = await show("src/components/Button.module.css");
	const names = await poll(async () => {
		const position = positionIn(css, "composes: focusable", "composes: ".length);
		const labels = (await completionsAt(css.uri, position)).items.map(labelOf);
		return labels.includes("focusable") ? labels : undefined;
	});
	assert.ok(names.includes("reset"));
	assert.ok(!names.includes("button"), "local classes leak into a `from` completion");

	const paths = await poll(async () => {
		const position = positionIn(css, 'from "@/styles', 'from "'.length);
		const labels = (await completionsAt(css.uri, position)).items.map(labelOf);
		return labels.includes("@/styles/base.module.css") ? labels : undefined;
	});
	assert.ok(paths.includes("Card.module.css"));
	assert.ok(!paths.includes("Button.module.css"), "a module is offered to compose itself");
});

test("composes definition jumps to the class and to the module", async () => {
	const css = await show("src/components/Button.module.css");
	const base = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(folder.uri, "src/styles/base.module.css"),
	);
	const focusable = positionIn(base, ".focusable", 1);
	const [name] = await poll(async () => {
		const locations = await definitions(
			css.uri,
			positionIn(css, "composes: focusable", "composes: f".length),
		);
		return locations.length > 0 ? locations : undefined;
	});
	assert.ok(name);
	assert.ok(targetPath(name).endsWith("base.module.css"), targetPath(name));
	assert.ok(targetRange(name).contains(focusable), "definition does not point at `.focusable`");

	const [file] = await poll(async () => {
		const locations = await definitions(css.uri, positionIn(css, "@/styles/base", 3));
		return locations.length > 0 ? locations : undefined;
	});
	assert.ok(file);
	assert.ok(targetPath(file).endsWith("base.module.css"), targetPath(file));
});

test("`var(--` completion offers global variables with their source", async () => {
	const css = await show("src/components/Button.module.css");
	const position = positionIn(css, "var(--space-2)", "var(--".length);
	const items = await poll(async () => {
		const { items } = await completionsAt(css.uri, position, "-");
		return items.some((item) => labelOf(item) === "--brand" && descriptionOf(item) === "colors.css")
			? items
			: undefined;
	});
	const brand = items.find((item) => labelOf(item) === "--brand" && descriptionOf(item) === "colors.css");
	assert.equal(brand?.kind, vscode.CompletionItemKind.Color);
	// The built-in CSS service also offers every referenced `--name` without a source, and provider merge order is racy.
	const space = items.find((item) => labelOf(item) === "--space-1" && descriptionOf(item) !== undefined);
	assert.equal(space && descriptionOf(space), "tokens.css");
});

test("`var()` references get color swatches", async () => {
	const css = await show("src/components/Button.module.css");
	const swatchAt = async (needle: string) => {
		const start = positionIn(css, needle);
		return poll(async () => {
			const colors = await vscode.commands.executeCommand<vscode.ColorInformation[]>(
				"vscode.executeDocumentColorProvider",
				css.uri,
			);
			return colors.find((info) => info.range.start.isEqual(start));
		});
	};
	const brand = await swatchAt("var(--brand)");
	assert.ok(brand.color.blue > brand.color.red, `--brand should be blue, got ${JSON.stringify(brand.color)}`);
	assert.equal(brand.range.end.character - brand.range.start.character, "var(--brand)".length);
	const accent = await swatchAt("var(--accent)");
	const { red, green, blue, alpha } = accent.color;
	assert.ok(
		[red - 1, green, blue, alpha - 0.5].every((delta) => Math.abs(delta) < 0.01),
		`--accent should resolve through its var() fallback to rgb(255 0 0 / 50%), got ${JSON.stringify(accent.color)}`,
	);
});

test("`@import` of a missing stylesheet is reported in CSS", async () => {
	const css = await show("src/app/broken.css");
	const missing = positionIn(css, "./missing.css");
	const diagnostic = await poll(() => ownDiagnostics(css.uri).find((item) => item.range.contains(missing)));
	assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
	assert.match(diagnostic.message, /Cannot find stylesheet '\.\/missing\.css'/);
	const found = positionIn(css, "./tokens.css");
	assert.ok(!ownDiagnostics(css.uri).some((item) => item.range.contains(found)), "existing import flagged");
});

test("a module redeclaring a `globalFiles` variable is warned", async () => {
	const css = await show("src/components/Card.module.css");
	const declaration = positionIn(css, "--bg");
	const diagnostic = await poll(() =>
		ownDiagnostics(css.uri).find((item) => item.range.contains(declaration)),
	);
	assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Warning);
	assert.match(diagnostic.message, /'--bg' shadows a global variable declared in globals\.css/);
});

test('a "Did you mean" quick fix renames the class', async () => {
	const tsx = await show("src/components/Typo.tsx");
	const typo = positionIn(tsx, "styles.buton", "styles.".length);
	const diagnostic = await poll(() => ownDiagnostics(tsx.uri).find((item) => item.range.contains(typo)));
	const action = await poll(async () => {
		const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
			"vscode.executeCodeActionProvider",
			tsx.uri,
			diagnostic.range,
		);
		return actions.find(
			(item): item is vscode.CodeAction => "edit" in item && item.title === "Did you mean 'button'?",
		);
	});
	assert.ok(action.edit, "quick fix has no edit");
	try {
		assert.ok(await vscode.workspace.applyEdit(action.edit));
		assert.match(tsx.getText(), /className=\{styles\.button\}/);
		await poll(() => (ownDiagnostics(tsx.uri).length === 0 ? true : undefined));
	} finally {
		await revert(tsx);
	}
	await poll(() => (ownDiagnostics(tsx.uri).some((item) => item.range.contains(typo)) ? true : undefined));
});

test("completion on an unbound `styles.` adds the import", async () => {
	const tsx = await show("src/components/Unbound.tsx");
	const position = positionIn(tsx, "styles.icon", "styles.".length);
	const item = await poll(async () =>
		(await completionsAt(tsx.uri, position, ".")).items.find(
			(item) => labelOf(item) === "icon" && (item.additionalTextEdits?.length ?? 0) > 0,
		),
	);
	const [edit, ...rest] = item.additionalTextEdits ?? [];
	assert.equal(rest.length, 0);
	assert.equal(edit?.newText, 'import styles from "./Button.module.css";\n');
	assert.ok(edit?.range.isEmpty && edit.range.start.isEqual(new vscode.Position(0, 0)));
});

export async function run(): Promise<void> {
	const [first] = vscode.workspace.workspaceFolders ?? [];
	assert.ok(first, "no workspace folder open");
	folder = first;
	const failures: string[] = [];
	doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, "src/components/Button.tsx"));
	await vscode.window.showTextDocument(doc);
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log(`  ok   ${name}`);
		} catch (error) {
			failures.push(name);
			console.error(`  FAIL ${name}\n${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length > 0) throw new Error(`${failures.length}/${tests.length} e2e tests failed`);
}
