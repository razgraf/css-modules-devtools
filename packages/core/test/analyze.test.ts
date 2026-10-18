import { describe, expect, test } from "bun:test";
import { analyzeTsx } from "../src";

const analyze = (text: string, file = "/x.tsx") => {
	const info = analyzeTsx(file, text);
	if (!info) throw new Error("parse failed");
	return info;
};
const keys = (text: string) => analyze(text).usages.map((u) => [u.binding.local, u.key, u.bracket]);

test("default import with any name, dot and bracket access", () => {
	const src = `import s from "./a.module.css";\n<div className={s.a + s["b-c"] + s[\`d\`] + s?.e + s[x]} />;`;
	expect(keys(src)).toEqual([
		["s", "a", false],
		["s", "b-c", true],
		["s", "d", true],
		["s", "e", false],
		["s", null, true],
	]);
});

test("usage locations point at the key", () => {
	const src = `import s from "./a.module.css";\ns["b-c"]; s.a;`;
	const info = analyze(src);
	const [bracket, dot] = info.usages;
	expect(src.slice(bracket?.loc.start.offset, bracket?.loc.end.offset)).toBe("b-c");
	expect(src.slice(dot?.loc.start.offset, dot?.loc.end.offset)).toBe("a");
	const spec = info.bindings[0]?.specifierLoc;
	expect(src.slice(spec?.start.offset, spec?.end.offset)).toBe("./a.module.css");
});

test("namespace and named imports, including aliases", () => {
	const src = `import * as ns from "./a.module.css";\nimport { a, b as bee, "c-d" as cd } from "./a.module.css";\nns.x; a; bee; cd; obj.a; ({ a: 1 });`;
	expect(keys(src)).toEqual([
		["a", "a", false],
		["bee", "b", false],
		["cd", "c-d", false],
		["ns", "x", false],
		["a", "a", false],
		["bee", "b", false],
		["cd", "c-d", false],
	]);
});

test("require, plain and destructured", () => {
	const src = `const s = require("./a.module.css");\nconst { a, b: bee } = require("./b.module.css");\ns.x; a; bee;`;
	const info = analyze(src, "/x.js");
	expect(info.bindings.map((b) => [b.local, b.kind, b.imported])).toEqual([
		["s", "require", undefined],
		["a", "named", "a"],
		["bee", "named", "b"],
	]);
	expect(info.usages.map((u) => u.key)).toEqual(["a", "b", "x", "a", "b"]);
});

test("ignores non-module stylesheets and other imports", () => {
	const info = analyze(`import "./global.css";\nimport x from "./x.css";\nimport React from "react";\nx.a;`);
	expect(info.bindings).toHaveLength(0);
	expect(info.importInsertOffset).toBeGreaterThan(0);
});

test("plain .ts files parse without jsx", () => {
	expect(analyze(`import s from "./a.module.css";\nconst x = <string>s.a;`, "/x.ts").usages).toHaveLength(1);
});

test("importInsertOffset is after the last import", () => {
	const src = `import a from "a";\nimport b from "b";\n\nexport const x = 1;`;
	expect(analyze(src).importInsertOffset).toBe(src.indexOf('"b";') + 4);
});

test("imports list every CSS-module import, side-effect ones included", () => {
	const src = [
		'import "./side.module.css";',
		'import s from "./a.module.css";',
		'import "./plain.css";',
		'const r = require("./b.module.css");',
		'require("./c.module.css");',
	].join("\n");
	const info = analyze(src);
	expect(info.imports.map((i) => i.specifier)).toEqual([
		"./side.module.css",
		"./a.module.css",
		"./b.module.css",
		"./c.module.css",
	]);
	const loc = info.imports[0]?.specifierLoc;
	expect(src.slice(loc?.start.offset, loc?.end.offset)).toBe("./side.module.css");
	expect(info.importInsertOffset).toBe(src.length);
});

test("string-query imports (?inline, ?url, ?raw) are imports but not class maps", () => {
	const src = [
		'import a from "./a.module.css?inline";',
		'import { x } from "./b.module.css?url";',
		'const c = require("./c.module.css?raw");',
		'import d from "./d.module.css?used&inline";',
		'import s from "./s.module.css?v=1";',
		"a.foo; x; c.bar; d.baz; s.ok;",
	].join("\n");
	const info = analyze(src);
	expect(info.imports.map((i) => i.specifier)).toEqual([
		"./a.module.css?inline",
		"./b.module.css?url",
		"./c.module.css?raw",
		"./d.module.css?used&inline",
		"./s.module.css?v=1",
	]);
	expect(info.bindings.map((b) => b.local)).toEqual(["s"]);
	expect(info.usages.map((u) => [u.binding.local, u.key])).toEqual([["s", "ok"]]);
});

describe("shadowed bindings are not usages", () => {
	const header = `import styles from "./a.module.css";\nimport { a } from "./b.module.css";\n`;
	const used = (body: string) => keys(header + body).map(([local, key]) => `${local}.${key}`);

	test("unshadowed access is still recorded", () => {
		expect(used("function B() { return styles.ok + a; }")).toEqual(["a.a", "styles.ok", "a.a"]);
	});

	test("TS namespace blocks", () => {
		expect(used("namespace N { const styles = theme; styles.palette; }\nstyles.ok;")).toEqual([
			"a.a",
			"styles.ok",
		]);
	});

	test("function params", () => {
		expect(used("function B(styles, a) { return styles.headerTitle + a; }")).toEqual(["a.a"]);
	});

	test("destructured, defaulted and rest params", () => {
		expect(
			used(
				[
					"function B({ styles }) { return styles.x; }",
					"function C({ theme: { styles } }) { return styles.x; }",
					"function D([styles] = []) { return styles.x; }",
					"function E(x = 1, ...styles) { return styles.x; }",
					"function F({ a = 1 }) { return a; }",
					"function G({ ...styles }) { return styles.x; }",
				].join("\n"),
			),
		).toEqual(["a.a"]);
	});

	test("arrow params and method params", () => {
		expect(
			used(
				[
					"const f = (styles) => styles.x;",
					"const g = styles => styles.x;",
					"const h = ({ a }) => a;",
					"({ m(styles) { return styles.x; } });",
					"class K { m(styles) { return styles.x; } }",
				].join("\n"),
			),
		).toEqual(["a.a"]);
	});

	test("nested shadowing, then un-shadowing", () => {
		const body = [
			"function Outer() {",
			"  styles.before;",
			"  function Inner(styles) { return styles.shadowed; }",
			"  const g = () => { const styles = useTheme(); return styles.palette; };",
			"  return styles.after;",
			"}",
		].join("\n");
		expect(used(body)).toEqual(["a.a", "styles.before", "styles.after"]);
	});

	test("block-scoped const inside if", () => {
		const body = [
			"function B(x) {",
			"  if (x) { const styles = useTheme(); styles.palette; let a = 1; a; }",
			"  return styles.outside + a;",
			"}",
		].join("\n");
		expect(used(body)).toEqual(["a.a", "styles.outside", "a.a"]);
	});

	test("var hoists to the function, not the block", () => {
		const body = "function B(x) { styles.hoisted; if (x) { var styles = {}; } }\nstyles.top;";
		expect(used(body)).toEqual(["a.a", "styles.top"]);
	});

	test("catch params", () => {
		expect(
			used("try {} catch (styles) { styles.message; }\ntry {} catch ({ a }) { a; }\nstyles.ok;"),
		).toEqual(["a.a", "styles.ok"]);
	});

	test("for heads, function and class declaration names", () => {
		const body = [
			"for (const styles of list) styles.x;",
			"for (let a = 0; a < 1; a++) a;",
			"for (const styles in obj) styles.y;",
			"{ function styles() {} styles.z; }",
			"{ class styles {} styles.w; }",
			"const f = function styles() { return styles.v; };",
			"const C = class styles { m() { return styles.u; } };",
			"switch (styles.disc) { case 1: const styles = 2; styles.t; }",
			"styles.ok;",
		].join("\n");
		expect(used(body)).toEqual(["a.a", "styles.disc", "styles.ok"]);
	});

	test("require bindings honor scope too", () => {
		const src = `const s = require("./a.module.css");\nfunction B(s) { return s.x; }\ns.ok;`;
		expect(analyze(src, "/x.js").usages.map((u) => u.key)).toEqual(["ok"]);
	});
});
