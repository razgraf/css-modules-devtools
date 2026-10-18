import path from "node:path";
import {
	analyzeTsx,
	exportMap,
	type ImportSpecifierPreference,
	MODULE_SUFFIX,
	type Resolver,
	type ScriptContext,
	scriptState,
} from "@css-modules-devtools/core";
import { type CompletionItem, CompletionItemKind, type TextEdit } from "vscode-languageserver";
import type { DocParams } from "../context";
import { IDENT_RE, relativeSpecifier } from "../lsp";

type MemberContext = Extract<ScriptContext, { kind: "member" }>;

const MAX_CANDIDATES = 10;

/** F5. Completions for an unbound `styles.` (any `autoImport.identifiers` name) that add the import. */
export function autoImportCompletions(p: DocParams, c: MemberContext): CompletionItem[] {
	const { ctx, file, text, offset } = p;
	if (!ctx.settings.autoImport.identifiers.includes(c.object)) return [];
	const dot = dotIndex(text, c.start);
	if (dot === undefined || scriptState(text, dot) === "comment" || !isUnbound(text, c.object)) return [];

	const { resolver } = ctx.project;
	const root = resolver.packageRoot(file) ?? resolver.workspaceFolder(file);
	if (!root) return [];

	const style = codeStyle(text);
	const insert = insertion(text, importOffset(file, text, dot, offset));
	const at = p.doc.positionAt(insert.at);
	const importEdit = (specifier: string): TextEdit => {
		const line = `import ${c.object} from ${style.quote}${specifier}${style.quote}${style.semi}`;
		return { range: { start: at, end: at }, newText: insert.wrap(line) };
	};

	const optional = text[dot - 1] === "?";
	const memberRange = { start: p.doc.positionAt(c.start), end: p.doc.positionAt(offset) };
	const bracketRange = { start: p.doc.positionAt(optional ? c.start : dot), end: memberRange.end };
	const convention = ctx.settings.classNameConvention;
	const preference = ctx.settings.autoImport.importModuleSpecifier;

	const items: CompletionItem[] = [];
	rankCandidates(ctx.project.moduleFiles(root, file), file)
		.slice(0, MAX_CANDIDATES)
		.forEach((target, rank) => {
			const info = ctx.project.cssInfo(target);
			if (!info) return;
			const specifier = moduleSpecifier(resolver, target, file, preference);
			const edit = importEdit(specifier);
			for (const key of exportMap(info.classes.keys(), convention).keys()) {
				const plain = IDENT_RE.test(key);
				items.push({
					label: key,
					kind: CompletionItemKind.Field,
					detail: `Auto import from ${specifier}`,
					labelDetails: { description: specifier },
					sortText: `${String(rank).padStart(2, "0")}:${key}`,
					// Same range start for every item (see classCompletions): after `?.` the bracket needs no dot,
					// otherwise identifiers are re-inserted with their dot.
					filterText: optional ? key : `.${key}`,
					textEdit:
						plain && !optional
							? { range: bracketRange, newText: `.${key}` }
							: plain
								? { range: memberRange, newText: key }
								: { range: bracketRange, newText: `[${style.quote}${key}${style.quote}]` },
					additionalTextEdits: [edit],
				});
			}
		});
	return items;
}

/** Offset of the `.` in `object.prefix`, or `undefined` when the object is itself a property (`a.styles.`). */
function dotIndex(text: string, start: number): number | undefined {
	const head = text.slice(Math.max(0, start - 300), start);
	const m = /((?<!\.\.)\.\s*)?[A-Za-z_$][\w$]*\s*\??(\.)\s*$/.exec(head);
	if (!m || m[1]) return undefined;
	return start - head.length + m.index + m[0].lastIndexOf(".");
}

/**
 * Heuristic, text-only: the name is bound when it appears anywhere as a standalone identifier other than
 * as the object of a member access (`name.x`, `name?.x`, `name[`). That covers imports, `const`/`let`/`var`,
 * functions, classes, parameters and destructuring without a full scope analysis; the cost is false
 * "bound" hits from comments, strings or object keys, which only suppress the suggestion.
 */
function isUnbound(text: string, name: string): boolean {
	const escaped = name.replaceAll("$", (d) => `\\${d}`);
	const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])(?!\\s*\\??\\.(?!\\.))(?!\\s*\\[)`, "g");
	for (const m of text.matchAll(re)) {
		const isProperty = text[m.index - 1] === "." && text.slice(m.index - 3, m.index) !== "...";
		if (!isProperty) return false;
	}
	return true;
}

const isWithin = (file: string, dir: string) => file === dir || file.startsWith(`${dir}${path.sep}`);

/** Same-basename sibling → same directory → ancestors (closest first) → the rest by path distance. */
function rankCandidates(files: string[], from: string): string[] {
	const dir = path.dirname(from);
	const base = path.basename(from).replace(/\.[^.]+$/, "");
	const score = (target: string): [number, number] => {
		const targetDir = path.dirname(target);
		const distance = path.relative(dir, targetDir).split(path.sep).filter(Boolean).length;
		if (targetDir === dir) return [path.basename(target, MODULE_SUFFIX) === base ? 0 : 1, 0];
		if (isWithin(dir, targetDir)) return [2, distance];
		return [3, distance];
	};
	return files
		.map((file) => ({ file, score: score(file) }))
		.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.file.localeCompare(b.file))
		.map((r) => r.file);
}

function moduleSpecifier(
	resolver: Resolver,
	target: string,
	from: string,
	preference: ImportSpecifierPreference,
): string {
	const relative = relativeSpecifier(target, from);
	const alias = () => resolver.aliasSpecifier(target, from);
	switch (preference) {
		case "relative":
			return relative;
		case "non-relative":
			return alias() ?? relative;
		case "shortest": {
			const short = alias();
			return short && short.length < relative.length ? short : relative;
		}
		case "project-relative": {
			const root = resolver.packageRoot(from);
			const same = root !== undefined && root === resolver.packageRoot(target);
			return same ? relative : (alias() ?? relative);
		}
	}
}

/** Quote and semicolon style of the file's first import, defaulting to `"` and `;`. */
function codeStyle(text: string): { quote: string; semi: string } {
	const m = /^\s*import\b[^'"`;]*?(['"])[^'"\n]*\1([ \t]*;)?/m.exec(text);
	if (!m) return { quote: '"', semi: ";" };
	return { quote: m[1] ?? '"', semi: m[2] ? ";" : "" };
}

/**
 * Where the new import goes. The half-typed `styles.` usually breaks the parse, so the member access is
 * cut out before analysing; offsets before the cursor are unchanged by that.
 */
function importOffset(file: string, text: string, dot: number, offset: number): number {
	const patched = text.slice(0, dot) + text.slice(offset);
	const after = analyzeTsx(file, patched)?.importInsertOffset ?? lastImportEnd(text.slice(0, dot));
	if (after > 0) return after;
	return /^(?:#![^\n]*\n)?(?:\s*(['"])use [^'"\n]+\1;?[^\S\n]*(?:\n|$))*/.exec(text)?.[0].length ?? 0;
}

function lastImportEnd(text: string): number {
	let end = 0;
	for (const m of text.matchAll(/^import\b[^'"]*?(['"])[^'"\n]+\1;?/gm)) end = m.index + m[0].length;
	return end;
}

/** Start of the line after `after` (the last import), so trailing comments stay on their own import. */
function insertion(text: string, after: number): { at: number; wrap: (line: string) => string } {
	if (after === 0 || text[after - 1] === "\n") return { at: after, wrap: (line) => `${line}\n` };
	const newline = text.indexOf("\n", after);
	if (newline === -1) return { at: text.length, wrap: (line) => `\n${line}` };
	return { at: newline + 1, wrap: (line) => `${line}\n` };
}
