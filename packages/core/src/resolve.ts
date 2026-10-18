import fs from "node:fs";
import path from "node:path";
import enhancedResolve from "enhanced-resolve";
import {
	createFilesMatcher,
	createPathsMatcher,
	getTsconfig,
	type PathsMatcher,
	parseTsconfig,
	type TsConfigResult,
} from "get-tsconfig";

export interface ResolverOptions {
	pathAlias: Record<string, string>;
	workspaceFolders: string[];
}

/** Export conditions tried for stylesheet entries, in priority order. */
export const STYLE_CONDITIONS: readonly string[] = ["style", "import", "require", "default"];

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

export const isInNodeModules = (file: string) => file.includes(NODE_MODULES);

export const isUrl = (specifier: string) =>
	/^(?:[a-z]+:)?\/\//i.test(specifier) || specifier.startsWith("data:");

const isStylesheet = (file: string) => file.endsWith(".css");

/** Drops bundler query / hash suffixes (`?inline`, `#x`); a leading `#` is a package `imports` key and stays. */
const stripSuffix = (specifier: string) => specifier.replace(/(?!^)[?#].*$/s, "");

/** Survives `path.resolve` so `paths` targets can be read back from get-tsconfig's matcher with `*` intact. */
const WILDCARD_PROBE = "\u0000";

const isWithin = (file: string, dir: string) => file === dir || file.startsWith(`${dir}${path.sep}`);

/**
 * Resolves stylesheet specifiers from TS/JS (`import`, `require`) and CSS (`composes … from`, `@import`).
 * Order: relative/absolute (a missing root-absolute `/x` retries from the package root, then the workspace
 * folder) → pathAlias setting → nearest tsconfig `paths` → package `imports` / node_modules (`~` stripped).
 */
export class Resolver {
	private readonly tsconfigCache = new Map<string, unknown>();
	private readonly matchers = new Map<string, PathsMatcher[]>();
	private readonly entries = new Map<string, { key: string; target: string }[]>();
	private readonly packageRoots = new Map<string, string | undefined>();
	// Owned rather than enhanced-resolve's process-wide default so `clear()` can drop its 4 s stat cache.
	private readonly fileSystem = new enhancedResolve.CachedInputFileSystem(fs, 4000);
	private readonly nodeResolve = enhancedResolve.create.sync({
		fileSystem: this.fileSystem,
		extensions: [".css"],
		conditionNames: [...STYLE_CONDITIONS],
		mainFields: ["style", "main"],
		exportsFields: ["exports"],
		importsFields: ["imports"],
		preferRelative: false,
	});

	constructor(private options: ResolverOptions) {}

	configure(options: ResolverOptions) {
		this.options = options;
		this.clear();
	}

	clear() {
		this.tsconfigCache.clear();
		this.matchers.clear();
		this.entries.clear();
		this.packageRoots.clear();
		this.fileSystem.purge();
	}

	resolve(raw: string, fromFile: string): string | undefined {
		if (!raw || isUrl(raw)) return undefined;
		const specifier = stripSuffix(raw);
		if (!specifier) return undefined;
		const dir = path.dirname(fromFile);

		if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
			const direct = this.existing(path.resolve(dir, specifier));
			if (direct || !specifier.startsWith("/")) return direct;
			return this.fromRoots(specifier, fromFile);
		}

		for (const candidate of this.aliasCandidates(specifier, fromFile)) {
			const found = this.existing(candidate);
			if (found) return found;
		}

		for (const matcher of this.pathsMatchers(fromFile)) {
			for (const candidate of matcher(specifier)) {
				const found = this.existing(candidate);
				if (found) return found;
			}
		}

		// Bare `foo.module.css` in CSS `@import` / `composes` is relative per CSS semantics; in TS/JS it is a package.
		if (isStylesheet(fromFile) && !specifier.startsWith("#")) {
			const relative = this.existing(path.resolve(dir, specifier));
			if (relative) return relative;
		}

		// css-loader's `~pkg/x.css` means "resolve as a module"; tried only after aliases since `~` is a common alias key.
		const request = specifier.startsWith("~") ? specifier.slice(1) : specifier;
		if (!request || request.startsWith("/")) return undefined;
		try {
			const result = this.nodeResolve(dir, request);
			return typeof result === "string" ? path.normalize(result) : undefined;
		} catch {
			return undefined;
		}
	}

	/** Vite-style root-absolute `/x`: relative to the package root, then the workspace folder. */
	private fromRoots(specifier: string, fromFile: string): string | undefined {
		const roots = new Set([this.packageRoot(fromFile), this.workspaceFolder(fromFile)]);
		for (const root of roots) {
			const found = root ? this.existing(path.join(root, specifier)) : undefined;
			if (found) return found;
		}
		return undefined;
	}

	/** Shortest tsconfig `paths` specifier that resolves to `target` from `fromFile`, if any. */
	aliasSpecifier(target: string, fromFile: string): string | undefined {
		const found: string[] = [];
		for (const { key, target: abs } of this.pathsEntries(fromFile)) {
			if (key.endsWith("*") && abs.endsWith("*")) {
				const prefix = abs.slice(0, -1);
				if (target.startsWith(prefix)) {
					found.push(key.slice(0, -1) + target.slice(prefix.length).split(path.sep).join("/"));
				}
			} else if (abs === target) {
				found.push(key);
			}
		}
		return found.sort((a, b) => a.length - b.length)[0];
	}

	/** Directories that the nearest tsconfig's wildcard `paths` entries point into. */
	pathsDirs(fromFile: string): string[] {
		const dirs = new Set<string>();
		for (const { key, target } of this.pathsEntries(fromFile)) {
			if (!key.endsWith("*") || !target.endsWith("*")) continue;
			const head = target.slice(0, -1);
			dirs.add(head.endsWith(path.sep) ? head.slice(0, -1) : path.dirname(head));
		}
		return [...dirs];
	}

	/** `pathAlias` setting entries with `${workspaceFolder}` / `${packageRoot}` expanded for `fromFile`. */
	pathAliases(fromFile: string): { key: string; dir: string }[] {
		const out: { key: string; dir: string }[] = [];
		for (const [rawKey, rawTarget] of Object.entries(this.options.pathAlias)) {
			const dir = this.interpolate(rawTarget.replace(/\/\*$/, ""), fromFile);
			if (dir) out.push({ key: rawKey.replace(/\/\*$/, ""), dir: path.normalize(dir) });
		}
		return out;
	}

	/**
	 * `paths` of the tsconfigs that own `fromFile`, each target made absolute (`*` kept). Targets are read
	 * back from get-tsconfig's matcher, which knows the base an inherited `paths` resolves against (the
	 * declaring config's directory when no `baseUrl` is set).
	 */
	private pathsEntries(fromFile: string): { key: string; target: string }[] {
		const dir = path.dirname(fromFile);
		const cached = this.entries.get(dir);
		if (cached) return cached;
		const result = this.configsFor(fromFile, true).flatMap((config) => {
			const paths = config.config.compilerOptions?.paths;
			const match = paths ? safePathsMatcher(config) : undefined;
			if (!paths || !match) return [];
			return Object.keys(paths).flatMap((key) =>
				match(key.replace("*", WILDCARD_PROBE)).map((target) => ({
					key,
					target: path.normalize(target.replace(WILDCARD_PROBE, "*")),
				})),
			);
		});
		this.entries.set(dir, result);
		return result;
	}

	/**
	 * Nearest tsconfig/jsconfig plus its solution-style `references`, the ones whose `include`/`files`
	 * cover `fromFile` first. `owningOnly` drops references that don't cover the file.
	 */
	private configsFor(fromFile: string, owningOnly = false): TsConfigResult[] {
		const cache = this.tsconfigCache as Map<string, never>;
		const nearest =
			getTsconfig(fromFile, "tsconfig.json", cache) ?? getTsconfig(fromFile, "jsconfig.json", cache);
		if (!nearest) return [];
		const referenced = (nearest.config.references ?? [])
			.map((ref) => {
				const target = path.resolve(path.dirname(nearest.path), ref.path);
				const file = target.endsWith(".json") ? target : path.join(target, "tsconfig.json");
				try {
					return { path: file, config: parseTsconfig(file, cache) } satisfies TsConfigResult;
				} catch {
					return undefined;
				}
			})
			.filter((r): r is TsConfigResult => r !== undefined);
		// `include` globs only match TS/JS extensions; a stylesheet belongs to the config that would own a script beside it.
		const owns = (r: TsConfigResult) => {
			const matches = createFilesMatcher(r);
			return matches(fromFile) || matches(`${fromFile}.ts`);
		};
		const owning = referenced.filter(owns);
		const others = owningOnly ? [] : referenced.filter((r) => !owning.includes(r));
		return [...owning, ...others, nearest];
	}

	/**
	 * Nearest directory with a package.json. Inside a workspace folder the walk stops at the folder, which
	 * is the answer when no package.json sits in between; outside every folder it walks to the filesystem root.
	 */
	packageRoot(file: string): string | undefined {
		const dir = path.dirname(file);
		if (this.packageRoots.has(dir)) return this.packageRoots.get(dir);
		const folder = this.workspaceFolder(dir);
		let current = dir;
		let found: string | undefined;
		while (true) {
			if (!isInNodeModules(`${current}${path.sep}`) && fs.existsSync(path.join(current, "package.json"))) {
				found = current;
				break;
			}
			if (current === folder) {
				found = folder;
				break;
			}
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		this.packageRoots.set(dir, found);
		return found;
	}

	workspaceFolder(file: string): string | undefined {
		return this.options.workspaceFolders
			.filter((folder) => isWithin(file, folder))
			.sort((a, b) => b.length - a.length)[0];
	}

	private aliasCandidates(specifier: string, fromFile: string): string[] {
		const out: string[] = [];
		for (const { key, dir } of this.pathAliases(fromFile)) {
			if (specifier !== key && !specifier.startsWith(`${key}/`)) continue;
			out.push(path.resolve(dir, specifier.slice(key.length).replace(/^\//, "")));
		}
		return out;
	}

	private interpolate(target: string, fromFile: string): string | undefined {
		let result = target;
		if (result.includes("${workspaceFolder}")) {
			const folder = this.workspaceFolder(fromFile);
			if (!folder) return undefined;
			result = result.replaceAll("${workspaceFolder}", folder);
		}
		if (result.includes("${packageRoot}")) {
			const root = this.packageRoot(fromFile);
			if (!root) return undefined;
			result = result.replaceAll("${packageRoot}", root);
		}
		if (path.isAbsolute(result)) return result;
		const base = this.workspaceFolder(fromFile);
		return base ? path.resolve(base, result) : undefined;
	}

	private pathsMatchers(fromFile: string): PathsMatcher[] {
		const dir = path.dirname(fromFile);
		const cached = this.matchers.get(dir);
		if (cached) return cached;

		const configs = this.configsFor(fromFile);
		const result = configs.map(createPathsMatcher).filter((m): m is PathsMatcher => m !== null);
		this.matchers.set(dir, result);
		return result;
	}

	/** Every resolution result passes through here, so all callers get platform-normalized paths. */
	protected existing(file: string): string | undefined {
		try {
			return fs.statSync(file).isFile() ? path.normalize(file) : undefined;
		} catch {
			return undefined;
		}
	}
}

/** get-tsconfig throws on `paths` it considers invalid (e.g. non-relative targets without `baseUrl`). */
function safePathsMatcher(config: TsConfigResult): PathsMatcher | undefined {
	try {
		return createPathsMatcher(config) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Names of TS plugins configured in the tsconfig nearest to `file`. */
export function tsconfigPlugins(file: string): string[] {
	const plugins = (getTsconfig(file)?.config.compilerOptions as { plugins?: { name?: string }[] } | undefined)
		?.plugins;
	return plugins?.flatMap((p) => (p.name ? [p.name] : [])) ?? [];
}
