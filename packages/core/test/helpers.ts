import path from "node:path";
import { defaultSettings, Project, type Settings } from "../src";

export const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures");

export const fixture = (...parts: string[]) => path.join(FIXTURES, ...parts);

export function project(root: string, overrides: Partial<Settings> = {}): Project {
	return new Project(undefined, { ...defaultSettings, ...overrides }, [root]);
}

/** Offset of the n-th (0-based) occurrence of `needle` in `text`, plus `delta`. */
export function offsetOf(text: string, needle: string, delta = 0, nth = 0): number {
	let index = -1;
	for (let i = 0; i <= nth; i++) {
		index = text.indexOf(needle, index + 1);
		if (index === -1) throw new Error(`"${needle}" not found`);
	}
	return index + delta;
}
