import path from "node:path";
import {
	type CssContext,
	pickDecl,
	type Rgba,
	readVar,
	resolveValue,
	type ScriptContext,
	stringRanges,
	toColor,
	type VarDecl,
} from "@css-modules-devtools/core";
import {
	type CompletionItem,
	CompletionItemKind,
	type Hover,
	type Location,
	MarkupKind,
	type Range,
} from "vscode-languageserver";
import type { DocParams } from "../context";
import { isScript, toLocation } from "../lsp";

/** A `var(--name[, fallback])` reference, as offsets into the document text. */
export interface VarRef {
	name: string;
	fallback: string | undefined;
	start: number;
	/** End of the whole expression, or of the name when the closing paren is missing. */
	end: number;
}

const MAX_EXPR = 1000;
const MAX_HOVER_DECLS = 5;

/** Parse the `var(` expression starting at `start`; an unclosed one spans only up to its name. */
export function parseVarRef(text: string, start: number, limit = text.length): VarRef | undefined {
	const expr = readVar(text, start, Math.min(limit, start + MAX_EXPR));
	if (!expr) return undefined;
	return { name: expr.name, fallback: expr.closed ? expr.fallback : undefined, start, end: expr.end };
}

/** `var()` references inside string literals, JSX attribute strings and template chunks of a script. */
export function scriptVarRefs(text: string): VarRef[] {
	const refs: VarRef[] = [];
	for (const range of stringRanges(text)) {
		const content = text.slice(range.start, range.end);
		for (const m of content.matchAll(/var\(/g)) {
			const ref = parseVarRef(text, range.start + (m.index ?? 0), range.end);
			if (ref) refs.push(ref);
		}
	}
	return refs;
}

/** `var()` references in declaration values of a stylesheet (comments and selectors excluded by the parser). */
export function cssVarRefs(p: DocParams): VarRef[] {
	return (p.ctx.project.cssInfo(p.file)?.varUses ?? [])
		.map((use) => ({
			name: use.name,
			fallback: use.expr.end.offset > use.loc.end.offset ? use.fallback : undefined,
			start: use.expr.start.offset,
			end: use.expr.end.offset,
		}))
		.sort((a, b) => a.start - b.start);
}

/** Custom properties visible from the document. */
export function knownVarsFor(p: DocParams): Map<string, VarDecl[]> {
	const { project } = p.ctx;
	return isScript(p.file) ? project.knownVarsForScript(p.file) : project.knownVars(p.file);
}

export const refRange = (p: DocParams, ref: VarRef): Range => ({
	start: p.doc.positionAt(ref.start),
	end: p.doc.positionAt(ref.end),
});

/** Innermost reference under the cursor, so `--b` wins inside `var(--a, var(--b))`. */
function refAt(p: DocParams): VarRef | undefined {
	let refs: VarRef[];
	if (isScript(p.file)) {
		if (!p.ctx.settings.variables.tsxStrings) return undefined;
		refs = scriptVarRefs(p.text);
	} else refs = cssVarRefs(p);
	let best: VarRef | undefined;
	for (const ref of refs) {
		if (p.offset >= ref.start && p.offset <= ref.end && (!best || ref.start >= best.start)) best = ref;
	}
	return best;
}

/** Color string VS Code turns into a swatch on `CompletionItemKind.Color` items. */
export function colorString({ red, green, blue, alpha }: Rgba): string {
	const channels = [red, green, blue].map((c) => Math.round(c * 255));
	if (alpha >= 1) return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
	return `rgba(${channels.join(", ")}, ${alpha.toFixed(2)})`;
}

function describe(decls: VarDecl[]): string {
	const lines = decls
		.slice(0, MAX_HOVER_DECLS)
		.map((d) => `\`${d.name}: ${d.value}\` · \`${d.selector}\` · ${path.basename(d.loc.file)}`);
	if (decls.length > MAX_HOVER_DECLS) lines.push(`…and ${decls.length - MAX_HOVER_DECLS} more`);
	return lines.join("  \n");
}

/** F7. */
export function varCompletions(
	p: DocParams,
	c: Extract<ScriptContext | CssContext, { kind: "var" }>,
): CompletionItem[] {
	const vars = knownVarsFor(p);
	const range = { start: p.doc.positionAt(c.start), end: p.doc.positionAt(p.offset) };
	// The built-in CSS language service already completes the current file's own properties.
	const ownExcluded = !isScript(p.file);
	const items: CompletionItem[] = [];
	for (const [name, decls] of vars) {
		if (!name.startsWith(c.prefix)) continue;
		if (ownExcluded && decls.every((d) => d.loc.file === p.file)) continue;
		const winner = pickDecl(decls);
		const value = resolveValue(`var(${name})`, vars) ?? winner?.value ?? "";
		const color = toColor(value);
		items.push({
			label: name,
			kind: color ? CompletionItemKind.Color : CompletionItemKind.Variable,
			detail: value,
			labelDetails: winner ? { description: path.basename(winner.loc.file) } : undefined,
			documentation: color ? colorString(color) : { kind: MarkupKind.Markdown, value: describe(decls) },
			textEdit: { range, newText: name },
		});
	}
	return items;
}

/** F7. */
export function varDefinition(p: DocParams): Location[] | undefined {
	const ref = refAt(p);
	if (!ref) return undefined;
	const decls = knownVarsFor(p).get(ref.name);
	return decls?.length ? decls.map((d) => toLocation(d.loc)) : undefined;
}

/** F7. */
export function varHover(p: DocParams): Hover | undefined {
	const ref = refAt(p);
	if (!ref) return undefined;
	const vars = knownVarsFor(p);
	const decls = vars.get(ref.name);
	if (!decls?.length) return undefined;
	let value = describe(decls);
	const resolved = resolveValue(`var(${ref.name})`, vars);
	if (resolved !== undefined && resolved !== pickDecl(decls)?.value) value += `\n\nResolved: \`${resolved}\``;
	return { contents: { kind: MarkupKind.Markdown, value }, range: refRange(p, ref) };
}
