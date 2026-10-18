import fs from "node:fs";
import path from "node:path";
import {
	type ClassDef,
	type Composes,
	type CssContext,
	contains,
	formatRule,
	importPatterns,
	isInNodeModules,
	MODULE_SUFFIX,
	type NameRef,
	type Project,
	packageStyleExports,
	rulesFor,
	targetFiles,
} from "@css-modules-devtools/core";
import {
	type CompletionItem,
	CompletionItemKind,
	type Hover,
	type Location,
	LocationLink,
	MarkupKind,
	type Range,
} from "vscode-languageserver";
import type { DocParams } from "../context";
import { toLocation, toRange, toUri } from "../lsp";
import { cssBlock, fileLink, firstDef } from "../markdown";

/** F6. */
export function composesCompletions(
	p: DocParams,
	c: Extract<CssContext, { kind: "composesName" | "composesPath" }>,
): CompletionItem[] {
	const range: Range = { start: p.doc.positionAt(c.start), end: p.doc.positionAt(p.offset) };
	return c.kind === "composesName" ? nameItems(p, c.specifier, range) : pathItems(p, c.prefix, range);
}

/** F6. The path returns a link so Cmd+hover underlines the whole specifier, not the word under the pointer. */
export function composesDefinition(p: DocParams): Location[] | LocationLink[] | undefined {
	const hit = composesAt(p);
	if (!hit) return undefined;
	const { project } = p.ctx;
	if (hit.kind === "path") {
		const target = project.resolve(hit.specifier, p.file);
		if (!target) return undefined;
		const zero = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
		return [LocationLink.create(toUri(target), zero, zero, hit.range)];
	}
	const defs = classDefs(project, p.file, hit.entry.from, hit.name.name);
	return defs.length > 0 ? defs.map((d) => toLocation(d.loc)) : undefined;
}

/** F6. */
export function composesHover(p: DocParams): Hover | undefined {
	const hit = composesAt(p);
	if (!hit) return undefined;
	const { project } = p.ctx;
	if (hit.kind === "path") {
		const target = project.resolve(hit.specifier, p.file);
		if (!target) return undefined;
		return { contents: markdown(`\`${displayPath(project, target)}\``), range: hit.range };
	}
	const name = hit.name.name;
	const max = p.ctx.settings.hover.maxLines;
	const sections = targetFiles(project, p.file, hit.entry.from, name).flatMap((file) => {
		const rules = rulesFor(project, file, name);
		if (rules.length === 0) return [];
		const block = cssBlock(
			rules
				.map((r) => formatRule(r))
				.join("\n\n")
				.split("\n"),
			max,
		);
		const section = `**.${name}** · ${path.basename(file)}\n${block.value}`;
		const def = firstDef(project.cssInfo(file), name);
		return [block.truncated && def ? `${section}\n\n${fileLink("Go to definition", def.loc)}` : section];
	});
	if (sections.length === 0) return undefined;
	return { contents: markdown(sections.join("\n\n")), range: toRange(hit.name.loc) };
}

type Hit =
	| { kind: "name"; entry: Composes; name: NameRef }
	| { kind: "path"; specifier: string; range: Range };

function composesAt(p: DocParams): Hit | undefined {
	const info = p.ctx.project.cssInfo(p.file);
	for (const entry of info?.composes ?? []) {
		if (!contains(entry.loc, p.offset)) continue;
		const name = entry.names.find((n) => contains(n.loc, p.offset));
		if (name) return { kind: "name", entry, name };
		const from = entry.from;
		if (from && from !== "global" && contains(from.loc, p.offset)) {
			return { kind: "path", specifier: from.specifier, range: toRange(from.loc) };
		}
	}
	return undefined;
}

/** Definitions of `name` in every file a `composes` source points to. */
function classDefs(project: Project, file: string, from: Composes["from"], name: string): ClassDef[] {
	return targetFiles(project, file, from, name).flatMap((target) => {
		const info = project.cssInfo(target);
		const local = info?.classes.get(name) ?? [];
		return from === "global" ? [...local, ...(info?.globals.get(name) ?? [])] : local;
	});
}

function nameItems(p: DocParams, specifier: string | "global" | null, range: Range): CompletionItem[] {
	const { project } = p.ctx;
	let classes: Map<string, ClassDef[]>;
	let exclude = new Set<string>();
	if (specifier === "global") {
		classes = project.globalScope(p.file).classes;
	} else if (specifier === null) {
		const info = project.cssInfo(p.file);
		if (!info) return [];
		classes = info.classes;
		exclude = ownerClasses(info.classes, p.offset);
	} else {
		const target = project.resolve(specifier, p.file);
		const info = target ? project.cssInfo(target) : undefined;
		if (!info) return [];
		classes = info.classes;
	}

	const items: CompletionItem[] = [];
	for (const [name, defs] of classes) {
		const first = defs[0];
		if (!first || exclude.has(name)) continue;
		items.push({
			label: name,
			kind: CompletionItemKind.Class,
			detail: `${path.basename(first.loc.file)}:${first.loc.start.line + 1}`,
			documentation: markdown(cssBlock(formatRule(first.rule).split("\n"), 0).value),
			textEdit: { range, newText: name },
		});
	}
	return items;
}

/** Local classes declared by the innermost rule around `offset` (a class can't compose itself). */
function ownerClasses(classes: Map<string, ClassDef[]>, offset: number): Set<string> {
	let rule: ClassDef["rule"] | undefined;
	for (const defs of classes.values()) {
		for (const d of defs) {
			if (contains(d.rule.loc, offset) && (!rule || d.rule.loc.start.offset > rule.loc.start.offset)) {
				rule = d.rule;
			}
		}
	}
	const out = new Set<string>();
	if (!rule) return out;
	for (const [name, defs] of classes) if (defs.some((d) => d.rule === rule)) out.add(name);
	return out;
}

function pathItems(p: DocParams, prefix: string, range: Range): CompletionItem[] {
	if (prefix.startsWith(".")) return relativeItems(p.file, prefix, range);
	const items = aliasItems(p, prefix, range);
	return prefix === "" ? [...relativeItems(p.file, "./", range), ...items] : items;
}

function relativeItems(file: string, prefix: string, range: Range): CompletionItem[] {
	const base =
		prefix === "." || prefix === ".." ? `${prefix}/` : prefix.slice(0, prefix.lastIndexOf("/") + 1);
	const dir = path.resolve(path.dirname(file), base);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const items: CompletionItem[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isDirectory()) {
			const newText = `${base}${entry.name}/`;
			items.push({
				label: `${entry.name}/`,
				kind: CompletionItemKind.Folder,
				filterText: newText,
				sortText: `0${entry.name}`,
				textEdit: { range, newText },
				command: { title: "Suggest", command: "editor.action.triggerSuggest" },
			});
		} else if (entry.name.endsWith(MODULE_SUFFIX) && path.join(dir, entry.name) !== file) {
			const newText = `${base}${entry.name}`;
			items.push({
				label: entry.name,
				kind: CompletionItemKind.File,
				filterText: newText,
				sortText: `1${entry.name}`,
				textEdit: { range, newText },
			});
		}
	}
	return items;
}

/**
 * Non-relative specifiers. Candidates come from a bounded scan of `*.module.css` files (package root,
 * `pathAlias` targets and tsconfig `paths` targets) mapped through tsconfig `paths`, `pathAlias` and package `imports`, plus the exact
 * `.module.css` exports of declared dependencies. Every candidate must round-trip through the resolver.
 */
function aliasItems(p: DocParams, prefix: string, range: Range): CompletionItem[] {
	const { project } = p.ctx;
	const { resolver } = project;
	const root = resolver.packageRoot(p.file) ?? resolver.workspaceFolder(p.file);
	const aliases = resolver.pathAliases(p.file);
	const paths = resolver.pathsDirs(p.file).filter((dir) => !isInNodeModules(`${dir}${path.sep}`));
	const roots = new Set([...(root ? [root] : []), ...aliases.map((a) => a.dir), ...paths]);
	const files = new Set([...roots].flatMap((dir) => project.moduleFiles(dir, p.file, true)));
	const imports = root ? importPatterns(root) : [];

	const found = new Map<string, string>();
	const offer = (specifier: string | undefined, target: string) => {
		if (!specifier?.startsWith(prefix) || found.has(specifier) || target === p.file) return;
		if (project.resolve(specifier, p.file) === target) found.set(specifier, target);
	};

	for (const file of files) {
		offer(resolver.aliasSpecifier(file, p.file), file);
		for (const alias of aliases)
			offer(
				underDir(file, alias.dir, (rest) => `${alias.key}/${rest}`),
				file,
			);
		for (const pattern of imports) {
			if (file.startsWith(pattern.head) && file.endsWith(pattern.tail)) {
				const middle = file.slice(pattern.head.length, file.length - pattern.tail.length);
				offer(pattern.key.replace("*", middle.split(path.sep).join("/")), file);
			}
		}
	}
	if (root) {
		for (const { specifier, target } of packageStyleExports(root, prefix)) offer(specifier, target);
	}

	return [...found.entries()].map(([specifier, target]) => ({
		label: specifier,
		kind: CompletionItemKind.File,
		detail: path.basename(target),
		sortText: `${specifier.length.toString().padStart(4, "0")}${specifier}`,
		textEdit: { range, newText: specifier },
	}));
}

function underDir(file: string, dir: string, format: (rest: string) => string): string | undefined {
	if (!file.startsWith(`${dir}${path.sep}`)) return undefined;
	return format(
		file
			.slice(dir.length + 1)
			.split(path.sep)
			.join("/"),
	);
}

function displayPath(project: Project, file: string): string {
	const folder = project.resolver.workspaceFolder(file);
	return folder ? path.relative(folder, file).split(path.sep).join("/") : file;
}

const markdown = (value: string) => ({ kind: MarkupKind.Markdown, value });
