import fs from "node:fs";
import path from "node:path";
import { STYLE_CONDITIONS } from "./resolve";
import { MODULE_SUFFIX } from "./walk";

export interface ImportPattern {
	/** The `imports` key, e.g. `#styles/*`. */
	key: string;
	/** Absolute target path before the `*`. */
	head: string;
	/** Target path after the `*`, platform separators. */
	tail: string;
}

/** Single-wildcard entries of the package's `imports` field, e.g. `"#styles/*": "./src/styles/*"`. */
export function importPatterns(root: string): ImportPattern[] {
	const imports = readJson(path.join(root, "package.json"))?.imports;
	if (!isRecord(imports)) return [];
	const out: ImportPattern[] = [];
	for (const [key, value] of Object.entries(imports)) {
		const target = conditionTarget(value);
		if (!target || key.split("*").length !== 2 || target.split("*").length !== 2) continue;
		const [head = "", tail = ""] = target.split("*");
		const dir = path.resolve(root, head);
		out.push({
			key,
			head: head.endsWith("/") ? `${dir}${path.sep}` : dir,
			tail: tail.split("/").join(path.sep),
		});
	}
	return out;
}

/** Exact `./x.module.css` exports of the dependencies of the package at `root` whose name could complete `prefix`. */
export function packageStyleExports(root: string, prefix: string): { specifier: string; target: string }[] {
	const manifest = readJson(path.join(root, "package.json"));
	const names = [manifest?.dependencies, manifest?.devDependencies].flatMap((deps) =>
		isRecord(deps) ? Object.keys(deps) : [],
	);
	const out: { specifier: string; target: string }[] = [];
	for (const name of names) {
		if (!name.startsWith(prefix) && !prefix.startsWith(`${name}/`)) continue;
		const manifestFile = findUp(root, path.join("node_modules", name, "package.json"));
		const dir = manifestFile ? path.dirname(manifestFile) : undefined;
		const exports = manifestFile ? readJson(manifestFile)?.exports : undefined;
		if (!dir || !isRecord(exports)) continue;
		for (const [key, value] of Object.entries(exports)) {
			const target = conditionTarget(value);
			if (!key.startsWith("./") || !key.endsWith(MODULE_SUFFIX) || key.includes("*") || !target) continue;
			const file = realpath(path.resolve(dir, target));
			if (file) out.push({ specifier: `${name}${key.slice(1)}`, target: file });
		}
	}
	return out;
}

/** `dir/name`, or the same relative path under the nearest ancestor of `dir` that has it. */
export function findUp(dir: string, name: string): string | undefined {
	let current = dir;
	while (true) {
		const candidate = path.join(current, name);
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function realpath(file: string): string | undefined {
	try {
		return fs.realpathSync.native(file);
	} catch {
		return undefined;
	}
}

function conditionTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return undefined;
	for (const condition of STYLE_CONDITIONS) {
		const target = conditionTarget(value[condition]);
		if (target) return target;
	}
	return undefined;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
