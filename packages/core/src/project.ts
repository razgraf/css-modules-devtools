import fs from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { parseCss } from "./css/parse";
import { isInNodeModules, isUrl, Resolver } from "./resolve";
import { analyzeTsx, type TsxInfo } from "./tsx/analyze";
import type { ClassDef, CssInfo, Settings, VarDecl } from "./types";
import { defaultSettings } from "./types";
import { moduleFiles } from "./walk";

export interface FileSource {
	read(file: string): string | undefined;
}

export const diskSource: FileSource = {
	read(file) {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
	},
};

export interface GlobalScope {
	/** Global files plus everything they `@import`, in walk order. */
	files: string[];
	vars: Map<string, VarDecl[]>;
	/** Local and `:global` classes of global files (a plain `.css` file's classes are all global at runtime). */
	classes: Map<string, ClassDef[]>;
}

const MAX_IMPORT_DEPTH = 20;
const WORKSPACE_PREFIX = "${workspaceFolder}/";
const GLOB_DEPTH = 12;
const MAX_GLOBAL_FILES = 500;

const isStylesheet = (file: string) => file.endsWith(".css");
const isWithin = (file: string, dir: string) => file === dir || file.startsWith(`${dir}${path.sep}`);

/**
 * Lazy, cached view of a workspace. Nothing is parsed until asked for.
 * Callers invalidate on edits (`invalidate`) and file create/delete (`filesChanged`).
 */
export class Project {
	readonly resolver: Resolver;
	private readonly css = new Map<string, CssInfo>();
	private readonly tsx = new Map<string, { text: string; info: TsxInfo }>();
	private readonly globs = new Map<string, string[]>();
	private readonly scopes = new Map<string, GlobalScope>();
	private readonly cssVars = new Map<string, Map<string, VarDecl[]>>();
	private readonly scriptVars = new Map<
		string,
		{ info: TsxInfo | undefined; vars: Map<string, VarDecl[]> }
	>();
	private readonly walks = new Map<string, string[]>();

	constructor(
		private readonly source: FileSource = diskSource,
		public settings: Settings = defaultSettings,
		public workspaceFolders: string[] = [],
	) {
		this.resolver = new Resolver({ pathAlias: settings.pathAlias, workspaceFolders });
	}

	configure(settings: Settings, workspaceFolders: string[] = this.workspaceFolders) {
		this.settings = settings;
		this.workspaceFolders = workspaceFolders;
		this.resolver.configure({ pathAlias: settings.pathAlias, workspaceFolders });
		this.globs.clear();
		this.walks.clear();
		this.clearScopes();
	}

	read(file: string): string | undefined {
		return this.source.read(file);
	}

	cssInfo(file: string): CssInfo | undefined {
		const cached = this.css.get(file);
		if (cached) return cached;
		const text = this.source.read(file);
		if (text === undefined) return undefined;
		const info = parseCss(file, text);
		this.css.set(file, info);
		return info;
	}

	/** Analysis of a TS/JS file. Keeps the last successful result when the current text doesn't parse. */
	tsxInfo(file: string, text = this.source.read(file)): TsxInfo | undefined {
		if (text === undefined) return undefined;
		const cached = this.tsx.get(file);
		if (cached?.text === text) return cached.info;
		const info = analyzeTsx(file, text);
		if (!info) return cached?.info;
		this.tsx.set(file, { text, info });
		return info;
	}

	/** Stylesheets parsed so far (no workspace scan). */
	indexedFiles(): string[] {
		return [...this.css.keys()];
	}

	resolve(specifier: string, fromFile: string): string | undefined {
		return this.resolver.resolve(specifier, fromFile);
	}

	/** Analysis of exactly `text`, or `undefined` while it doesn't parse (no stale fallback). */
	parsedTsxInfo(file: string, text: string): TsxInfo | undefined {
		const info = this.tsxInfo(file, text);
		return this.tsx.get(file)?.text === text ? info : undefined;
	}

	/** Content of `file` changed (edit or save). */
	invalidate(file: string) {
		// TS/JS entries are checked against the text on every lookup; keeping them preserves the last good
		// parse that completion, definition and hover fall back on while the file is mid-edit.
		if (!isStylesheet(file)) return;
		this.css.delete(file);
		// Any stylesheet can be in some file's import graph, so the per-file var maps always go; the shared
		// global scopes only when the file is part of one.
		this.cssVars.clear();
		this.scriptVars.clear();
		for (const scope of this.scopes.values()) {
			if (scope.files.includes(file)) {
				this.scopes.clear();
				break;
			}
		}
	}

	/**
	 * Files or directories were created, deleted or renamed, or a tsconfig/package.json changed. With
	 * `changes`, only those paths (and anything below them) are dropped from the parsed stylesheets;
	 * without, every parsed stylesheet goes. Resolution, globs, walks and scopes are always rebuilt.
	 */
	filesChanged(changes?: string[]) {
		if (changes) {
			for (const file of this.css.keys()) {
				if (changes.some((changed) => isWithin(file, changed))) this.css.delete(file);
			}
		} else {
			this.css.clear();
		}
		this.globs.clear();
		this.walks.clear();
		this.clearScopes();
		this.resolver.clear();
	}

	/** `*.module.css` files under `root` (bounded walk, see `moduleFiles` in walk.ts), cached until `filesChanged`. */
	moduleFiles(root: string, from?: string, nestedPackages = false): string[] {
		const base = nestedPackages ? `${root}\n*` : root;
		const complete = this.walks.get(base);
		if (complete) return complete;
		// A truncated walk depends on where it started, so it's only reused for the same directory.
		const key = from ? `${base}\n${path.dirname(from)}` : base;
		const partial = this.walks.get(key);
		if (partial) return partial;
		const walk = moduleFiles(root, { from, nestedPackages });
		this.walks.set(walk.complete ? base : key, walk.files);
		return walk.files;
	}

	private clearScopes() {
		this.scopes.clear();
		this.cssVars.clear();
		this.scriptVars.clear();
	}

	/** `file` followed by everything it transitively `@import`s. Cycle-safe. */
	importGraph(file: string): string[] {
		const visited = new Set<string>();
		const order: string[] = [];
		const walk = (current: string, depth: number) => {
			if (visited.has(current) || depth > MAX_IMPORT_DEPTH) return;
			visited.add(current);
			order.push(current);
			for (const ref of this.cssInfo(current)?.imports ?? []) {
				if (isUrl(ref.specifier)) continue;
				const target = this.resolve(ref.specifier, current);
				if (!target || (!this.settings.nodeModules.enabled && isInNodeModules(target))) continue;
				walk(target, depth + 1);
			}
		};
		walk(file, 0);
		return order;
	}

	globalFiles(file: string): string[] {
		const root = this.resolver.packageRoot(file) ?? this.resolver.workspaceFolder(file);
		if (!root) return [];
		const cached = this.globs.get(root);
		if (cached) return cached;

		const ignore = this.settings.nodeModules.enabled ? [] : ["**/node_modules/**"];
		const folder = this.resolver.workspaceFolder(file);
		const found = new Set<string>();
		for (const pattern of this.settings.globalFiles) {
			const fromWorkspace = pattern.startsWith(WORKSPACE_PREFIX);
			const cwd = fromWorkspace ? folder : root;
			if (!cwd) continue;
			const glob = fromWorkspace ? pattern.slice(WORKSPACE_PREFIX.length) : pattern;
			const matches = globSync(glob, {
				cwd,
				absolute: true,
				ignore,
				dot: false,
				followSymbolicLinks: false,
				deep: GLOB_DEPTH,
			});
			for (const match of matches) found.add(path.normalize(match));
		}
		// tinyglobby has no entry limit; this caps what gets parsed, not the directory walk (`deep` bounds that).
		const result = [...found].sort().slice(0, MAX_GLOBAL_FILES);
		this.globs.set(root, result);
		return result;
	}

	globalScope(file: string): GlobalScope {
		const roots = this.globalFiles(file);
		const key = roots.join("\n");
		const cached = this.scopes.get(key);
		if (cached) return cached;

		const files: string[] = [];
		const seen = new Set<string>();
		for (const root of roots) {
			for (const f of this.importGraph(root)) {
				if (!seen.has(f)) {
					seen.add(f);
					files.push(f);
				}
			}
		}
		const scope: GlobalScope = { files, vars: new Map(), classes: new Map() };
		for (const f of files) {
			const info = this.cssInfo(f);
			if (!info) continue;
			for (const v of info.varDecls) push(scope.vars, v.name, v);
			for (const [name, defs] of info.classes) for (const d of defs) push(scope.classes, name, d);
			for (const [name, defs] of info.globals) for (const d of defs) push(scope.classes, name, d);
		}
		this.scopes.set(key, scope);
		return scope;
	}

	/** Custom properties visible in a stylesheet: own + transitive `@import`s + global files. Shared; don't mutate. */
	knownVars(cssFile: string): Map<string, VarDecl[]> {
		const cached = this.cssVars.get(cssFile);
		if (cached) return cached;
		const vars = new VarCollector();
		for (const f of this.importGraph(cssFile)) vars.addAll(this.cssInfo(f)?.varDecls ?? []);
		vars.addMap(this.globalScope(cssFile).vars);
		this.cssVars.set(cssFile, vars.map);
		return vars.map;
	}

	/** Custom properties visible in a TS/JS file: those of every imported CSS module + global files. Shared; don't mutate. */
	knownVarsForScript(file: string): Map<string, VarDecl[]> {
		const info = this.tsxInfo(file);
		const cached = this.scriptVars.get(file);
		if (cached && cached.info === info) return cached.vars;
		const vars = new VarCollector();
		for (const binding of info?.bindings ?? []) {
			const target = this.resolve(binding.specifier, file);
			if (target) vars.addMap(this.knownVars(target));
		}
		vars.addMap(this.globalScope(file).vars);
		this.scriptVars.set(file, { info, vars: vars.map });
		return vars.map;
	}
}

class VarCollector {
	readonly map = new Map<string, VarDecl[]>();
	private readonly seen = new Set<VarDecl>();

	addAll(decls: Iterable<VarDecl>) {
		for (const d of decls) {
			if (this.seen.has(d)) continue;
			this.seen.add(d);
			push(this.map, d.name, d);
		}
	}

	addMap(source: Map<string, VarDecl[]>) {
		for (const decls of source.values()) this.addAll(decls);
	}
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}
