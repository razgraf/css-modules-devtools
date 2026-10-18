import path from "node:path";
import {
	analyzeTsx,
	CSS_MODULE_RE,
	type CssInfo,
	composedSources,
	contains,
	exportMap,
	formatRule,
	type Loc,
	type ModuleBinding,
	type RuleInfo,
	rulesFor,
	type ScriptContext,
	type Usage,
} from "@css-modules-devtools/core";
import {
	type CompletionItem,
	CompletionItemKind,
	type Hover,
	type Location,
	MarkupKind,
	type Range,
} from "vscode-languageserver";
import type { DocParams, FeatureContext } from "../context";
import { IDENT_RE, relativeSpecifier, toLocation, toRange, toUri } from "../lsp";
import { cssBlock, fileLink, firstDef } from "../markdown";

type ClassContext = Extract<ScriptContext, { kind: "member" | "bracket" | "named" }>;

interface Target {
	file: string;
	info: CssInfo;
	/** Exported key → class name. */
	keys: Map<string, string>;
}

const IMPORT_RE = /^[ \t]*import\s[^;]*?from\s*(['"])[^'"\n]+\1/gm;
const REQUIRE_RE = /^[ \t]*(?:const|let|var)\s[^=;]+=\s*require\(\s*(['"])[^'"\n]+\1\s*\)/gm;
const COMPOSED_SEPARATOR = "/* ---- composed ---- */";

/** Payload of a class completion item; documentation is filled in on resolve. */
export interface ClassItemData {
	kind: "class";
	file: string;
	name: string;
}

/** F1. `undefined` when the object isn't a CSS-module binding (auto-import may take over). */
export function classCompletions(p: DocParams, c: ClassContext): CompletionItem[] | undefined {
	if (c.kind === "named") {
		if (!CSS_MODULE_RE.test(c.specifier)) return undefined;
		const target = loadTarget(p, c.specifier);
		if (!target) return [];
		return [...target.keys.keys()]
			.filter((key) => IDENT_RE.test(key))
			.map((key) => item(target, key, key, rangeOf(p, c.start, p.offset)));
	}

	const binding = objectBinding(p, c.object);
	if (!binding) return undefined;
	const target = loadTarget(p, binding.specifier);
	if (!target) return [];

	if (c.kind === "bracket") {
		const range = rangeOf(p, c.start, p.offset);
		return [...target.keys.keys()]
			.filter((key) => !key.includes(c.quote))
			.map((key) => item(target, key, key, range));
	}

	// Every item replaces from the dot (kebab keys need it for bracket form). Mixed range starts would make
	// the client score kebab items against "." and the rest against "", floating kebab keys to the top.
	const dot = p.text.lastIndexOf(".", c.start - 1);
	const optional = p.text[dot - 1] === "?";
	const range = rangeOf(p, dot, p.offset);
	return [...target.keys.keys()].map((key) => {
		const newText = IDENT_RE.test(key) ? `.${key}` : `${optional ? "." : ""}['${key}']`;
		return { ...item(target, key, newText, range), filterText: `.${key}` };
	});
}

/** F2. */
export function classDefinition(p: DocParams): Location[] | undefined {
	const info = p.ctx.project.tsxInfo(p.file, p.text);
	if (!info) return undefined;

	const specifier = info.bindings.find((b) => contains(b.specifierLoc, p.offset));
	if (specifier) {
		const file = p.ctx.project.resolve(specifier.specifier, p.file);
		if (!file) return undefined;
		const start = { line: 0, character: 0 };
		return [{ uri: toUri(file), range: { start, end: start } }];
	}

	const found = classAt(p, info.usages);
	if (!found) return undefined;
	const defs = found.target.info.classes.get(found.name) ?? [];
	return defs.length > 0 ? defs.map((d) => toLocation(d.loc)) : undefined;
}

/** F3. */
export function classHover(p: DocParams): Hover | undefined {
	const info = p.ctx.project.tsxInfo(p.file, p.text);
	if (!info) return undefined;
	const found = classAt(p, info.usages);
	if (!found) return undefined;
	const { target, name, usage } = found;
	const { project, settings } = p.ctx;

	const rules = rulesFor(project, target.file, name);
	if (rules.length === 0) return undefined;

	const shown = new Set(rules);
	const composed: RuleInfo[] = [];
	const origins: { file: string; loc: Loc }[] = [];
	for (const source of composedSources(project, target.file, name)) {
		const fresh = source.rules.filter((r) => !shown.has(r));
		if (fresh.length === 0) continue;
		for (const rule of fresh) shown.add(rule);
		composed.push(...fresh);
		const def = firstDef(project.cssInfo(source.file), source.className);
		if (def && !origins.some((o) => o.file === source.file))
			origins.push({ file: source.file, loc: def.loc });
	}

	const blocks = rules.map((rule) => formatRule(rule));
	if (composed.length > 0) blocks.push(COMPOSED_SEPARATOR, ...composed.map((rule) => formatRule(rule)));

	const block = cssBlock(blocks.join("\n\n").split("\n"), settings.hover.maxLines);
	const parts = [block.value];
	if (origins.length > 0) {
		const links = origins.map((o) => fileLink(relativeSpecifier(o.file, target.file), o.loc));
		parts.push(`Composed from ${links.join(", ")}`);
	}
	const def = firstDef(target.info, name);
	if (block.truncated && def) parts.push(fileLink("Go to definition", def.loc));

	return {
		contents: { kind: MarkupKind.Markdown, value: parts.join("\n\n") },
		range: toRange(usage.loc),
	};
}

/** F1 resolve: documentation is the class's first rule, computed only for the focused item. */
export function resolveClassCompletion(
	ctx: FeatureContext,
	item: CompletionItem,
	data: ClassItemData,
): CompletionItem {
	const rule = rulesFor(ctx.project, data.file, data.name)[0];
	if (!rule) return item;
	return {
		...item,
		documentation: { kind: MarkupKind.Markdown, value: cssBlock(formatRule(rule).split("\n"), 0).value },
	};
}

function item(target: Target, key: string, newText: string, range: Range): CompletionItem {
	const name = target.keys.get(key) ?? key;
	const first = target.info.classes.get(name)?.[0];
	const base = path.basename(target.file);
	const data: ClassItemData = { kind: "class", file: target.file, name };
	return {
		label: key,
		kind: CompletionItemKind.Property,
		detail: first ? `${base}:${first.loc.start.line + 1}` : base,
		textEdit: { range, newText },
		data,
	};
}

function rangeOf(p: DocParams, start: number, end: number): Range {
	return { start: p.doc.positionAt(start), end: p.doc.positionAt(end) };
}

/**
 * Object-like binding (`default`, `namespace`, `require`) named `local`. Half-typed code (`styles.`) often
 * doesn't parse, so when the cached analysis lacks it, re-analyze just the file's import/require statements.
 */
function objectBinding(p: DocParams, local: string): ModuleBinding | undefined {
	const isObject = (b: ModuleBinding) => b.local === local && b.kind !== "named";
	const found = p.ctx.project.tsxInfo(p.file, p.text)?.bindings.find(isObject);
	if (found) return found;
	const header = [...p.text.matchAll(IMPORT_RE), ...p.text.matchAll(REQUIRE_RE)].map((m) => m[0]).join(";\n");
	if (!header.includes(local)) return undefined;
	return analyzeTsx(p.file, header)?.bindings.find(isObject);
}

function loadTarget(p: DocParams, specifier: string): Target | undefined {
	const file = p.ctx.project.resolve(specifier, p.file);
	const info = file ? p.ctx.project.cssInfo(file) : undefined;
	if (!file || !info) return undefined;
	return { file, info, keys: exportMap(info.classes.keys(), p.ctx.settings.classNameConvention) };
}

/** Usage under the cursor whose key maps to a class of its (resolvable) module. */
function classAt(p: DocParams, usages: Usage[]) {
	const usage = usages.find(
		(u) =>
			u.key !== null &&
			contains(u.loc, p.offset) &&
			// Stale analysis (current text didn't parse) can point anywhere; trust it only where the text still matches.
			matches(p.text.slice(u.loc.start.offset, u.loc.end.offset), u),
	);
	if (!usage?.key) return undefined;
	const target = loadTarget(p, usage.binding.specifier);
	const name = target?.keys.get(usage.key);
	if (!target || !name) return undefined;
	return { usage, target, name };
}

const matches = (text: string, u: Usage) =>
	text === u.key || (u.binding.kind === "named" && text === u.binding.local);
