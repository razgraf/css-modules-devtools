import { expect, test } from "bun:test";
import { parseCss, resolveValue, toColor, type VarDecl, varColor } from "../src";

const vars = (css: string) => {
	const map = new Map<string, VarDecl[]>();
	for (const d of parseCss("/v.css", css).varDecls) map.set(d.name, [...(map.get(d.name) ?? []), d]);
	return map;
};

test.each([
	"#ff0000",
	"rgb(255 0 0)",
	"hsl(0 100% 50%)",
	"red",
	"oklch(62.8% 0.2577 29.23)",
	"lab(54% 81 70)",
])("parses %s", (value) => {
	const c = toColor(value);
	expect(c?.red).toBeCloseTo(1, 1);
	expect(c?.green).toBeCloseTo(0, 1);
});

test("non-colors", () => {
	expect(toColor("4px")).toBeUndefined();
	expect(toColor("calc(1px + 2px)")).toBeUndefined();
});

test("nested vars, fallbacks and cycles", () => {
	const v = vars(
		":root { --a: #00f; --b: var(--a); --c: var(--nope, var(--b)); --x: var(--y); --y: var(--x); }",
	);
	expect(resolveValue("var(--c)", v)).toBe("#00f");
	expect(varColor("--c", undefined, v)?.blue).toBe(1);
	expect(varColor("--x", undefined, v)).toBeUndefined();
	expect(varColor("--missing", "green", v)?.green).toBeGreaterThan(0.4);
});

test("prefers the shallowest declaration", () => {
	const v = vars(":root { --a: red; } .x { .y { --a: blue; } }");
	expect(resolveValue("var(--a)", v)).toBe("red");
});

test("prefers root-scope declarations over theme overrides at the same depth", () => {
	const v = vars(':root { --bg: #fff; } [data-theme="dark"] { --bg: #000; } .card { --bg: red; }');
	expect(resolveValue("var(--bg)", v)).toBe("#fff");
	const g = vars(":global(:root) { --a: 1px; } :where(html) { --a: 2px; } .x { --a: 3px; }");
	expect(resolveValue("var(--a)", g)).toBe("2px");
	expect(resolveValue("var(--b)", vars(".a { --b: 1; } .c { --b: 2; }"))).toBe("2");
});

test.each(["hwb(0 0% 0%)", "oklab(62.8% 0.2249 0.1258)", "lch(54% 107 41)", "#f00f", "rgba(255, 0, 0, 1)"])(
	"parses %s",
	(value) => {
		const c = toColor(value);
		expect(c?.red).toBeCloseTo(1, 1);
		expect(c?.green).toBeCloseTo(0, 1);
	},
);

test("transparent has zero alpha", () => {
	expect(toColor("transparent")?.alpha).toBe(0);
});

test("a var() followed by other tokens is not a pure reference", () => {
	const v = vars(
		":root { --w: 2px; --c: #00f; --border: var(--c, red) solid var(--w); --pad: var(--w) var(--w); }",
	);
	expect(resolveValue("var(--w, 1px) solid var(--c)", v)).toBe("var(--w, 1px) solid var(--c)");
	expect(resolveValue("var(--border)", v)).toBe("var(--c, red) solid var(--w)");
	expect(varColor("--border", undefined, v)).toBeUndefined();
	expect(resolveValue("var(--pad)", v)).toBe("var(--w) var(--w)");
	expect(resolveValue("var(--nope, var(--w))", v)).toBe("2px");
	expect(resolveValue("var(--a", v)).toBe("var(--a");
});

test.each([
	"color(srgb 1 0 0)",
	"color(srgb-linear 1 0 0)",
	"color(display-p3 0.92 0.2 0.14)",
	"color(rec2020 0.79 0.23 0.07)",
	"color(a98-rgb 0.86 0 0)",
	"color(prophoto-rgb 0.702 0.2757 0.1036)",
	"color(xyz-d65 0.41 0.21 0.02)",
	"color(xyz-d50 0.44 0.22 0.01)",
])("parses %s", (value) => {
	const c = toColor(value);
	expect(c?.red).toBeCloseTo(1, 1);
	expect(c?.green).toBeCloseTo(0, 1);
});
