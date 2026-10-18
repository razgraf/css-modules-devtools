import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { findUp, importPatterns, packageStyleExports } from "../src";
import { fixture } from "./helpers";

test("importPatterns reads single-wildcard imports", () => {
	expect(importPatterns(fixture("aliases"))).toEqual([
		{ key: "#styles/*", head: `${fixture("aliases/src/styles")}${path.sep}`, tail: "" },
	]);
	expect(importPatterns(fixture("next-app"))).toEqual([]);
});

test("packageStyleExports lists exact module exports of matching dependencies", () => {
	const web = fixture("monorepo/apps/web");
	const target = fs.realpathSync.native(fixture("monorepo/packages/ui/src/shared.module.css"));
	expect(packageStyleExports(web, "@repo")).toEqual([{ specifier: "@repo/ui/shared.module.css", target }]);
	expect(packageStyleExports(web, "@repo/ui/")).toHaveLength(1);
	expect(packageStyleExports(web, "other")).toEqual([]);
});

test("findUp", () => {
	expect(findUp(fixture("monorepo/apps/web/src"), "tsconfig.base.json")).toBe(
		fixture("monorepo/tsconfig.base.json"),
	);
	expect(findUp(fixture("monorepo/apps/web/src"), "nope.json")).toBeUndefined();
});
