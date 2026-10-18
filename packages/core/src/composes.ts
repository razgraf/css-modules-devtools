import type { Project } from "./project";
import type { CssInfo, RuleInfo } from "./types";

export interface ComposedSource {
	file: string;
	className: string;
	rules: RuleInfo[];
	depth: number;
}

const MAX_DEPTH = 5;

const ruleIndex = new WeakMap<CssInfo, Map<string, RuleInfo[]>>();

function indexRules(info: CssInfo): Map<string, RuleInfo[]> {
	const cached = ruleIndex.get(info);
	if (cached) return cached;
	const index = new Map<string, RuleInfo[]>();
	for (const rule of info.rules) {
		for (const cls of rule.classes) {
			const list = index.get(cls);
			if (list) list.push(rule);
			else index.set(cls, [rule]);
		}
	}
	ruleIndex.set(info, index);
	return index;
}

/** Rules containing `.className` in `file`, in source order. */
export function rulesFor(project: Project, file: string, className: string): RuleInfo[] {
	const info = project.cssInfo(file);
	if (!info) return [];
	return [...(indexRules(info).get(className) ?? [])];
}

/**
 * Classes that `.className` composes, recursively (depth ≤ 5, cycle-safe), in application order.
 * `from global` sources are looked up in the global scope's files.
 */
export function composedSources(project: Project, file: string, className: string): ComposedSource[] {
	const out: ComposedSource[] = [];
	const seen = new Set<string>([`${file}\0${className}`]);

	const visit = (currentFile: string, current: string, depth: number) => {
		if (depth > MAX_DEPTH) return;
		const info = project.cssInfo(currentFile);
		for (const entry of info?.composes ?? []) {
			if (!entry.owners.includes(current)) continue;
			for (const { name } of entry.names) {
				const targets = targetFiles(project, currentFile, entry.from, name);
				for (const target of targets) {
					const key = `${target}\0${name}`;
					if (seen.has(key)) continue;
					seen.add(key);
					visit(target, name, depth + 1);
					out.push({ file: target, className: name, rules: rulesFor(project, target, name), depth });
				}
			}
		}
	};

	visit(file, className, 1);
	return out;
}

export function targetFiles(
	project: Project,
	file: string,
	from: { specifier: string } | "global" | null,
	name: string,
): string[] {
	if (from === null) return [file];
	if (from === "global") {
		return project.globalScope(file).files.filter((f) => {
			const info = project.cssInfo(f);
			return info?.classes.has(name) || info?.globals.has(name);
		});
	}
	const resolved = project.resolve(from.specifier, file);
	return resolved ? [resolved] : [];
}
