import { describe, expect, test } from "bun:test";
import { formatRule, parseCss } from "../src";

const parse = (css: string) => parseCss("/x.module.css", css);

describe("classes", () => {
	test("collects local classes with exact locations", () => {
		const css = ".a, .b-c { color: red }";
		const info = parse(css);
		expect([...info.classes.keys()]).toEqual(["a", "b-c"]);
		const loc = info.classes.get("b-c")?.[0]?.loc;
		expect(css.slice(loc?.start.offset, loc?.end.offset)).toBe("b-c");
	});

	test("separates :global(), bare :global and :local", () => {
		const info = parse(":global(.g) .l {} :global .g2 .g3 {} :local(.l2) {} .x:not(.y) {}");
		expect([...info.classes.keys()].sort()).toEqual(["l", "l2", "x", "y"]);
		expect([...info.globals.keys()].sort()).toEqual(["g", "g2", "g3"]);
	});

	test("resolves native nesting", () => {
		const info = parse(".card { color: red; &:hover { color: blue } .title { top: 0 } }");
		expect([...info.classes.keys()]).toEqual(["card", "title"]);
		const selectors = info.rules.map((r) => r.selector);
		expect(selectors).toEqual([".card", ".card:hover", ".card .title"]);
		expect(info.rules[1]?.classes.has("card")).toBe(true);
		expect(info.rules.map((r) => r.depth)).toEqual([0, 1, 1]);
	});

	test("records at-rule wrappers and skips keyframes", () => {
		const info = parse(
			"@media (min-width: 1px) { @supports (x: y) { .a { top: 0 } } } @keyframes k { from { top: 0 } }",
		);
		expect(info.rules).toHaveLength(1);
		expect(info.rules[0]?.wrappers).toEqual(["@media (min-width: 1px)", "@supports (x: y)"]);
		expect(info.rules[0]?.depth).toBe(0);
	});

	test("declarations in an at-rule nested in a rule get their own wrapped rule", () => {
		const info = parse(
			".box { color: red; @media (x) { color: blue; .t { top: 0 } @supports (y) { left: 0 } } }",
		);
		expect(
			info.rules.map((r) => [r.selector, r.wrappers, r.depth, r.declarations.map((d) => d.value)]),
		).toEqual([
			[".box", [], 0, ["red"]],
			[".box", ["@media (x)"], 0, ["blue"]],
			[".box .t", ["@media (x)"], 1, ["0"]],
			[".box", ["@media (x)", "@supports (y)"], 0, ["0"]],
		]);
		expect(info.rules[1]?.classes.has("box")).toBe(true);
		expect(info.classes.get("box")).toHaveLength(1);
	});

	test("nested at-rule without declarations adds no rule", () => {
		const info = parse(".box { @media (x) { .t { top: 0 } } }");
		expect(info.rules.map((r) => [r.selector, r.wrappers])).toEqual([
			[".box", []],
			[".box .t", ["@media (x)"]],
		]);
	});

	test("nested custom properties keep rule nesting depth", () => {
		const info = parse(".x { --a: 1; @media (x) { --a: 2; } .y { @media (y) { --b: 3; } } }");
		expect(info.varDecls.map((d) => [d.name, d.depth, d.selector])).toEqual([
			["--a", 0, ".x"],
			["--a", 0, ".x"],
			["--b", 1, ".x .y"],
		]);
	});

	test("splits only top-level selectors when resolving nesting", () => {
		const info = parse(
			".a { :is(.x, .y) & { top: 0 } &:not(&.z) { top: 1 } } .b, .c { & + .d, .e { top: 2 } }",
		);
		expect(info.rules.map((r) => r.selector)).toEqual([
			".a",
			":is(.x, .y) .a",
			".a:not(.a.z)",
			".b, .c",
			":is(.b, .c) + .d, :is(.b, .c) .e",
		]);
	});

	test("does not attribute &-suffix concatenation rules to the parent class", () => {
		const info = parse(
			".card { &-icon { top: 0; .inner { left: 0 } } &__el { top: 1 } &-x, &:hover { top: 2 } }",
		);
		expect(info.rules.map((r) => [r.selector, [...r.classes].sort()])).toEqual([
			[".card", ["card"]],
			[".card-icon", []],
			[".card-icon .inner", ["inner"]],
			[".card__el", []],
			[".card-x, .card:hover", ["card"]],
		]);
		expect([...info.classes.keys()].sort()).toEqual(["card", "inner"]);
	});

	test("records @layer and @container wrappers", () => {
		const info = parse(
			"@layer base { .a { top: 0 } } @container card (min-width: 20rem) { .b { top: 0 } } .c { @layer x { top: 1 } }",
		);
		expect(info.rules.map((r) => [r.selector, r.wrappers])).toEqual([
			[".a", ["@layer base"]],
			[".b", ["@container card (min-width: 20rem)"]],
			[".c", []],
			[".c", ["@layer x"]],
		]);
		const container = info.rules[1];
		if (!container) throw new Error("no rule");
		expect(formatRule(container)).toBe("@container card (min-width: 20rem) {\n  .b {\n    top: 0;\n  }\n}");
	});

	test("class locations across combinators, compounds and line breaks", () => {
		const css = "div.a\n  > .b-c ~ .d_1 + p .e.f {} .g..h {} .i. {} .-j .--k {}";
		const info = parse(css);
		expect([...info.classes.keys()]).toEqual(["a", "b-c", "d_1", "e", "f", "g", "", "h", "i", "-j", "--k"]);
		for (const [name, defs] of info.classes) {
			const loc = defs[0]?.loc;
			expect(css.slice(loc?.start.offset, loc?.end.offset)).toBe(name);
		}
		expect(info.rules.map((r) => r.selector)).toEqual([
			"div.a\n  > .b-c ~ .d_1 + p .e.f",
			".g..h",
			".i.",
			".-j .--k",
		]);
	});

	test("does not re-parse resolved parent selectors in deep nesting", () => {
		let css = "";
		for (let i = 0; i < 16; i++) css += `.a${i}, .b${i} { top: 0; `;
		css += "}".repeat(16);
		const t = performance.now();
		const info = parse(css);
		expect(performance.now() - t).toBeLessThan(100);
		expect(info.rules[1]?.selector).toBe(":is(.a0, .b0) .a1, :is(.a0, .b0) .b1");
		expect(info.rules[15]?.classes.size).toBe(32);
	});

	test("tolerates half-typed input", () => {
		const info = parse(".a { color: red }\n.b { color: ");
		expect([...info.classes.keys()]).toEqual(["a", "b"]);
	});
});

describe("composes", () => {
	test("local, file and global forms", () => {
		const css = `.a { composes: b c; }
.d { composes: e from "./other.module.css"; }
.f { composes: g from global; }`;
		const info = parse(css);
		expect(info.composes.map((c) => [c.owners, c.names.map((n) => n.name), c.from])).toEqual([
			[["a"], ["b", "c"], null],
			[["d"], ["e"], expect.objectContaining({ specifier: "./other.module.css" })],
			[["f"], ["g"], "global"],
		]);
		const from = info.composes[1]?.from;
		if (from && from !== "global")
			expect(css.slice(from.loc.start.offset, from.loc.end.offset)).toBe("./other.module.css");
		const name = info.composes[0]?.names[1]?.loc;
		expect(css.slice(name?.start.offset, name?.end.offset)).toBe("c");
	});

	test("half-typed and look-alike from clauses", () => {
		const info = parse(
			`.a { composes: x from; } .b { composes: fromage from 'y.css' ; } .c { composes: z from globals; } .d { composes: w  from  global }`,
		);
		expect(info.composes.map((c) => [c.names.map((n) => n.name), c.from])).toEqual([
			[["x", "from"], null],
			[["fromage"], expect.objectContaining({ specifier: "y.css" })],
			[["z", "from", "globals"], null],
			[["w"], "global"],
		]);
	});

	test("parses long values in linear time", () => {
		const css = `.a { composes: x${"\n".repeat(5000)}y; } .b { composes: p${" ".repeat(5000)}q from "./q.css"; }`;
		const t = performance.now();
		const info = parse(css);
		expect(performance.now() - t).toBeLessThan(50);
		expect(info.composes.map((c) => [c.names.map((n) => n.name), c.from])).toEqual([
			[["x", "y"], null],
			[["p", "q"], expect.objectContaining({ specifier: "./q.css" })],
		]);
	});

	test("locations skip comments", () => {
		const css = `.a { composes: b /* c */ d from './x.css'; } .e { composes: /* f */ g /* from "h" */; }`;
		const info = parse(css);
		const span = (loc: { start: { offset: number }; end: { offset: number } } | undefined) =>
			css.slice(loc?.start.offset, loc?.end.offset);
		expect(info.composes.map((c) => c.names.map((n) => [n.name, span(n.loc)]))).toEqual([
			[
				["b", "b"],
				["d", "d"],
			],
			[["g", "g"]],
		]);
		const from = info.composes[0]?.from;
		expect(from && from !== "global" ? span(from.loc) : undefined).toBe("./x.css");
		expect(info.composes[1]?.from).toBeNull();
	});
});

describe("variables", () => {
	test("declarations with depth and uses with fallbacks", () => {
		const css =
			":root { --a: 1px; } .x { --b: var(--a); .y { --c: var(--d, red); } } @property --e { syntax: '<color>'; initial-value: blue; }";
		const info = parse(css);
		expect(info.varDecls.map((d) => [d.name, d.depth, d.value])).toEqual([
			["--a", 0, "1px"],
			["--b", 0, "var(--a)"],
			["--c", 1, "var(--d, red)"],
			["--e", 0, "blue"],
		]);
		expect(info.varUses.map((u) => [u.name, u.fallback])).toEqual([
			["--a", undefined],
			["--d", "red"],
		]);
		const use = info.varUses[1]?.loc;
		expect(css.slice(use?.start.offset, use?.end.offset)).toBe("--d");
	});

	test("balanced fallbacks and nested uses", () => {
		const css = ".x { color: var(--a, rgb(0 0 0 / 50%)); top: var(--b, var(--c, 1px)); left: var(--d,";
		const info = parse(css);
		expect(info.varUses.map((u) => [u.name, u.fallback])).toEqual([
			["--a", "rgb(0 0 0 / 50%)"],
			["--b", "var(--c, 1px)"],
			["--c", "1px"],
			["--d", undefined],
		]);
		const span = (loc: { start: { offset: number }; end: { offset: number } } | undefined) =>
			css.slice(loc?.start.offset, loc?.end.offset);
		expect(info.varUses.map((u) => span(u.expr))).toEqual([
			"var(--a, rgb(0 0 0 / 50%))",
			"var(--b, var(--c, 1px))",
			"var(--c, 1px)",
			"var(--d",
		]);
	});

	test("locations and fallbacks skip comments", () => {
		const css =
			".x { margin: var(--x) /* c */ var(--yy); color: var(--a, /* ) var(--no) */ red); top: 1px /* var(--no2) */; }";
		const info = parse(css);
		const span = (loc: { start: { offset: number }; end: { offset: number } } | undefined) =>
			css.slice(loc?.start.offset, loc?.end.offset);
		expect(info.varUses.map((u) => [u.name, u.fallback, span(u.loc), span(u.expr)])).toEqual([
			["--x", undefined, "--x", "var(--x)"],
			["--yy", undefined, "--yy", "var(--yy)"],
			["--a", "red", "--a", "var(--a, /* ) var(--no) */ red)"],
		]);
		expect(info.rules[0]?.declarations.map((d) => d.value)).toEqual([
			"var(--x)  var(--yy)",
			"var(--a,  red)",
			"1px ",
		]);
	});
});

describe("imports", () => {
	test("string and url forms", () => {
		const css = `@import "./a.css";\n@import url(b.css) layer(x);\n@import 'https://x.dev/c.css';`;
		const info = parse(css);
		expect(info.imports.map((i) => i.specifier)).toEqual(["./a.css", "b.css", "https://x.dev/c.css"]);
		const loc = info.imports[0]?.loc;
		expect(css.slice(loc?.start.offset, loc?.end.offset)).toBe("./a.css");
	});
});

test("formatRule prints wrappers and declarations", () => {
	const info = parse("@media (x) { .a { color: red; top: 0 !important } }");
	const rule = info.rules[0];
	if (!rule) throw new Error("no rule");
	expect(formatRule(rule)).toBe("@media (x) {\n  .a {\n    color: red;\n    top: 0 !important;\n  }\n}");
});
