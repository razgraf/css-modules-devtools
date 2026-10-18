import fs from "node:fs";
import path from "node:path";

export const MODULE_SUFFIX = ".module.css";

export interface WalkOptions {
	/** Its directory chain (up to `root`) is visited first so nearby files survive the budget. */
	from?: string;
	/** Directories read before the walk gives up. */
	maxDirs?: number;
	/** Descend into folders with their own package.json (alias targets often are workspace packages). */
	nestedPackages?: boolean;
}

export interface ModuleWalk {
	files: string[];
	/** `false` when the budget ran out; the result then depends on `from`. */
	complete: boolean;
}

const MAX_DIRS = 2000;

/** `*.module.css` files under `root`, breadth-first, skipping node_modules, dot-dirs and (by default) nested packages. */
export function moduleFiles(root: string, options: WalkOptions = {}): ModuleWalk {
	const maxDirs = options.maxDirs ?? MAX_DIRS;
	const nested = options.nestedPackages ?? false;
	const queue: string[] = [];
	if (options.from) {
		// Only directories the BFS would also enter, so a complete walk doesn't depend on `from`.
		const chain: string[] = [];
		for (let dir = path.dirname(options.from); isWithin(dir, root); dir = path.dirname(dir)) {
			chain.push(dir);
			if (dir === root) break;
		}
		let first = 0;
		chain.forEach((dir, i) => {
			if (dir !== root && skipDir(path.basename(dir), dir, nested)) first = i + 1;
		});
		queue.push(...chain.slice(first));
	}
	if (queue.at(-1) !== root) queue.push(root);

	const files: string[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const dir = queue.shift();
		if (dir === undefined || seen.has(dir)) continue;
		if (seen.size >= maxDirs) return { files, complete: false };
		seen.add(dir);
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isFile() && entry.name.endsWith(MODULE_SUFFIX)) files.push(full);
			else if (entry.isDirectory() && !skipDir(entry.name, full, nested)) queue.push(full);
		}
	}
	return { files, complete: true };
}

function skipDir(name: string, full: string, nestedPackages: boolean): boolean {
	if (name === "node_modules" || name.startsWith(".")) return true;
	return !nestedPackages && fs.existsSync(path.join(full, "package.json"));
}

const isWithin = (file: string, dir: string) => file === dir || file.startsWith(`${dir}${path.sep}`);
