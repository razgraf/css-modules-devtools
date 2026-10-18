import path from "node:path";
import {
	type DiagnosticRule,
	exportMap,
	isUrl,
	LineIndex,
	type Loc,
	type ModuleBinding,
	type Usage,
} from "@css-modules-devtools/core";
import {
	type CodeAction,
	CodeActionKind,
	type CodeActionParams,
	type Diagnostic,
	type Range,
	TextEdit,
} from "vscode-languageserver";
import type { DocParams } from "../context";
import { IDENT_RE, isScript, SOURCE, toRange, toSeverity, toUri } from "../lsp";

/**
 * How a missing key was written, so a rename keeps the code valid:
 * `member` = `styles.key`, `quoted` = text inside quotes, `import` / `require` = named binding
 * (with `local` when it's shorthand and the local name must survive), `css` = `composes` name.
 */
type Shape = "member" | "quoted" | "import" | "require" | "css";

export interface MissingData {
	rule: DiagnosticRule;
	key: string;
	/** Stylesheet the key was looked up in. */
	file?: string;
	shape?: Shape;
	local?: string;
}

const MAX_DISTANCE = 2;
const MAX_SUGGESTIONS = 3;
const CSS_IDENT_RE = /^-?[A-Za-z_][\w-]*$/;

/** F4. `missingClass` / `missingFile` in scripts. */
export function scriptDiagnostics(p: DocParams): Diagnostic[] {
	const { project, settings } = p.ctx;
	// A stale analysis would put diagnostics at outdated offsets; report nothing until the text parses.
	const info = project.parsedTsxInfo(p.file, p.text);
	if (!info) return [];
	const out: Diagnostic[] = [];
	const targets = new Map<string, string | undefined>();
	const target = (b: { specifier: string }) => {
		if (!targets.has(b.specifier)) targets.set(b.specifier, project.resolve(b.specifier, p.file));
		return targets.get(b.specifier);
	};

	for (const ref of info.imports) {
		if (target(ref)) continue;
		push(out, p, ref.specifierLoc, `Cannot find stylesheet '${ref.specifier}'`, {
			rule: "missingFile",
			key: ref.specifier,
		});
	}

	const keys = new Map<string, Map<string, string>>();
	const named = new Set<ModuleBinding>();
	for (const usage of info.usages) {
		if (usage.key === null) continue;
		// Named bindings: only the declaration site (recorded first) is flagged, not every reference.
		if (usage.binding.kind === "named") {
			if (named.has(usage.binding)) continue;
			named.add(usage.binding);
		}
		const file = target(usage.binding);
		if (!file) continue;
		let exported = keys.get(file);
		if (!exported) {
			const css = project.cssInfo(file);
			if (!css) continue;
			exported = exportMap(css.classes.keys(), settings.classNameConvention);
			keys.set(file, exported);
		}
		if (exported.has(usage.key)) continue;
		push(out, p, usage.loc, `Class '${usage.key}' does not exist in ${path.basename(file)}`, {
			rule: "missingClass",
			key: usage.key,
			file,
			...shapeOf(p.text, usage),
		});
	}
	return out;
}

/** F4. `missingClass` / `missingFile` for `composes` and `@import` in stylesheets. */
export function cssMissingDiagnostics(p: DocParams): Diagnostic[] {
	const { project } = p.ctx;
	const info = project.cssInfo(p.file);
	if (!info) return [];
	const out: Diagnostic[] = [];

	for (const ref of info.imports) {
		if (isUrl(ref.specifier) || project.resolve(ref.specifier, p.file)) continue;
		push(out, p, ref.loc, `Cannot find stylesheet '${ref.specifier}'`, {
			rule: "missingFile",
			key: ref.specifier,
		});
	}

	for (const entry of info.composes) {
		if (entry.from === "global") continue;
		let file = p.file;
		let classes = info.classes;
		if (entry.from) {
			const resolved = project.resolve(entry.from.specifier, p.file);
			if (!resolved) {
				push(out, p, entry.from.loc, `Cannot find stylesheet '${entry.from.specifier}'`, {
					rule: "missingFile",
					key: entry.from.specifier,
				});
				continue;
			}
			const target = project.cssInfo(resolved);
			if (!target) continue;
			file = resolved;
			classes = target.classes;
		}
		for (const name of entry.names) {
			if (classes.has(name.name)) continue;
			push(out, p, name.loc, `Class '${name.name}' does not exist in ${path.basename(file)}`, {
				rule: "missingClass",
				key: name.name,
				file,
				shape: "css",
			});
		}
	}
	return out;
}

/** F4. "Did you mean" and "Add rule" quick fixes. */
export function quickFixes(p: DocParams, params: CodeActionParams): CodeAction[] {
	const { project, settings } = p.ctx;
	const actions: CodeAction[] = [];
	for (const diagnostic of params.context.diagnostics) {
		if (diagnostic.source !== SOURCE || diagnostic.code !== "missingClass") continue;
		const data = missingData(diagnostic.data);
		if (!data?.file || !data.shape) continue;
		const css = project.cssInfo(data.file);
		if (!css) continue;

		const candidates = isScript(p.file)
			? [...exportMap(css.classes.keys(), settings.classNameConvention).keys()]
			: [...css.classes.keys()];
		for (const suggestion of suggest(data.key, candidates)) {
			const edit = renameEdit(p, diagnostic.range, data, suggestion);
			if (!edit) continue;
			actions.push({
				title: `Did you mean '${suggestion}'?`,
				kind: CodeActionKind.QuickFix,
				diagnostics: [diagnostic],
				edit: { changes: { [p.doc.uri]: [edit] } },
			});
		}

		const add = addRuleEdit(project.read(data.file), data.key);
		if (add) {
			actions.push({
				title: `Add '.${data.key} {}' to ${path.basename(data.file)}`,
				kind: CodeActionKind.QuickFix,
				diagnostics: [diagnostic],
				edit: { changes: { [toUri(data.file)]: [add] } },
			});
		}
	}
	return actions;
}

function push(out: Diagnostic[], p: DocParams, loc: Loc, message: string, data: MissingData) {
	const severity = toSeverity(p.ctx.settings.diagnostics[data.rule]);
	if (severity === undefined) return;
	out.push({ range: toRange(loc), severity, source: SOURCE, code: data.rule, message, data });
}

function shapeOf(text: string, usage: Usage): Pick<MissingData, "shape" | "local"> {
	const start = usage.loc.start.offset;
	if (/['"`]/.test(text.charAt(start - 1))) return { shape: "quoted" };
	if (usage.binding.kind !== "named") return { shape: "member" };
	const between = text.slice(usage.loc.end.offset, usage.binding.specifierLoc.start.offset);
	const shape = /\brequire\b/.test(between) ? "require" : "import";
	const shorthand =
		usage.binding.local === usage.key && text.slice(start, usage.loc.end.offset) === usage.key;
	return shorthand && !/^\s*(?:as\b|:)/.test(between) ? { shape, local: usage.binding.local } : { shape };
}

function renameEdit(p: DocParams, range: Range, data: MissingData, suggestion: string): TextEdit | undefined {
	switch (data.shape) {
		case "quoted":
		case "css":
			return TextEdit.replace(range, suggestion);
		case "member": {
			if (IDENT_RE.test(suggestion)) return TextEdit.replace(range, suggestion);
			const start = p.doc.offsetAt(range.start);
			if (p.text.charAt(start - 1) !== ".") return undefined;
			const access = `[${JSON.stringify(suggestion)}]`;
			if (p.text.charAt(start - 2) === "?") return TextEdit.replace(range, access);
			return TextEdit.replace({ start: p.doc.positionAt(start - 1), end: range.end }, access);
		}
		case "import":
		case "require": {
			const name = IDENT_RE.test(suggestion) ? suggestion : JSON.stringify(suggestion);
			if (!data.local) return TextEdit.replace(range, name);
			const separator = data.shape === "import" ? " as " : ": ";
			return TextEdit.replace(range, `${name}${separator}${data.local}`);
		}
		default:
			return undefined;
	}
}

function addRuleEdit(text: string | undefined, key: string): TextEdit | undefined {
	if (text === undefined || !CSS_IDENT_RE.test(key)) return undefined;
	const end = new LineIndex(text).pos(text.length);
	const lead = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return TextEdit.insert({ line: end.line, character: end.character }, `${lead}.${key} {\n}\n`);
}

function suggest(key: string, candidates: string[]): string[] {
	return candidates
		.filter((c) => c !== key)
		.map((c) => ({ c, d: distance(key, c) }))
		.filter(({ d }) => d <= MAX_DISTANCE)
		.sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
		.slice(0, MAX_SUGGESTIONS)
		.map(({ c }) => c);
}

function distance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > MAX_DISTANCE) return MAX_DISTANCE + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row.push(Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost));
		}
		prev = row;
	}
	return prev[b.length] ?? 0;
}

const SHAPES: readonly Shape[] = ["member", "quoted", "import", "require", "css"];
const isShape = (value: unknown): value is Shape => SHAPES.some((s) => s === value);

function missingData(value: unknown): MissingData | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { rule, key, file, shape, local } = value as Record<string, unknown>;
	if (rule !== "missingClass" || typeof key !== "string") return undefined;
	return {
		rule,
		key,
		file: typeof file === "string" ? file : undefined,
		shape: isShape(shape) ? shape : undefined,
		local: typeof local === "string" ? local : undefined,
	};
}
