import { expect, test } from "bun:test";
import { moduleFiles } from "../src";
import { fixture } from "./helpers";

const root = fixture("auto-import");

test("finds modules, skipping node_modules, dot-dirs and nested packages", () => {
	const walk = moduleFiles(root);
	expect(walk.complete).toBe(true);
	expect(walk.files).toContain(fixture("auto-import/src/root.module.css"));
	expect(walk.files).toContain(fixture("auto-import/src/features/profile/Avatar.module.css"));
	expect(walk.files).toHaveLength(17);
	for (const skipped of ["node_modules", ".hidden", "vendored"]) {
		expect(walk.files.some((f) => f.includes(`/${skipped}/`))).toBe(false);
	}
});

test("visits the from file's directory chain first within the budget", () => {
	const walk = moduleFiles(root, {
		from: fixture("auto-import/src/features/profile/Profile.tsx"),
		maxDirs: 2,
	});
	expect(walk.complete).toBe(false);
	expect(walk.files.sort()).toEqual([
		fixture("auto-import/src/features/feature.module.css"),
		fixture("auto-import/src/features/profile/Avatar.module.css"),
		fixture("auto-import/src/features/profile/Profile.module.css"),
	]);
});

test("missing root", () => {
	expect(moduleFiles(fixture("nope"))).toEqual({ files: [], complete: true });
});

test("nestedPackages descends into folders with their own package.json", () => {
	const walk = moduleFiles(root, { nestedPackages: true });
	expect(walk.files).toContain(fixture("auto-import/src/vendored/vendored.module.css"));
	expect(walk.files.some((f) => f.includes("/node_modules/") || f.includes("/.hidden/"))).toBe(false);
});

test("a from file inside a skipped folder doesn't change a complete walk", () => {
	const plain = moduleFiles(root).files.sort();
	expect(moduleFiles(root, { from: fixture("auto-import/src/vendored/Vendored.tsx") }).files.sort()).toEqual(
		plain,
	);
	expect(moduleFiles(root, { from: fixture("auto-import/src/.hidden/x.tsx") }).files.sort()).toEqual(plain);
});
