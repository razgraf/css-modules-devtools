import { describe, expect, test } from "bun:test";
import type { Settings } from "@css-modules-devtools/core";
import type { ColorInformation } from "vscode-languageserver";
import type { DocParams } from "../src/context";
import { documentColors } from "../src/features/colors";
import { colors } from "../src/router";
import { setup } from "./helpers";

const NEXT = { globalFiles: ["src/app/globals.css"] };
const BUTTON_CSS = "src/components/Button.module.css";
const BUTTON_TSX = "src/components/Button.tsx";
const BRAND = { red: 0.046, green: 0.516, blue: 0.981, alpha: 1 };

/** Each swatch as the covered text plus its color rounded to 3 decimals. */
function swatches(p: DocParams, list: ColorInformation[] = documentColors(p)) {
	return list.map(({ range, color }) => ({
		text: p.text.slice(p.doc.offsetAt(range.start), p.doc.offsetAt(range.end)),
		color: {
			red: round(color.red),
			green: round(color.green),
			blue: round(color.blue),
			alpha: round(color.alpha),
		},
	}));
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const texts = (p: DocParams) => swatches(p).map((s) => s.text);
const vars = (overrides: Partial<Settings["variables"]>): Pick<Settings, "variables"> => ({
	variables: { enabled: true, tsxStrings: true, colors: true, ...overrides },
});

describe("documentColors in stylesheets", () => {
	test("resolves globals through nested vars and fallbacks; skips non-colors", () => {
		const { open } = setup("next-app", NEXT);
		const list = swatches(open(BUTTON_CSS));
		expect(list.find((s) => s.text === "var(--brand)")?.color).toEqual(BRAND);
		expect(list.find((s) => s.text === "var(--brand-alias)")?.color).toEqual(BRAND);
		expect(list.find((s) => s.text === "var(--accent)")?.color).toEqual({
			red: 1,
			green: 0,
			blue: 0,
			alpha: 0.5,
		});
		expect(list.map((s) => s.text)).not.toContain("var(--space-2)");
		expect(list.map((s) => s.text)).not.toContain("var(--space-1)");
	});

	test("range covers the whole var() expression", () => {
		const { open } = setup("next-app", NEXT);
		const [first] = documentColors(open(BUTTON_CSS));
		expect(first?.range).toEqual({ start: { line: 2, character: 8 }, end: { line: 2, character: 20 } });
	});

	test("fallbacks with nested parens, unresolvable vars and literal colors", () => {
		const { open } = setup("next-app", NEXT);
		const p = open(
			"src/app/page.css",
			[
				".a { color: var(--nope, rgb(0 128 0 / 25%)); }",
				".b { color: var(--nope); }",
				".c { color: #ff0000; border: 1px solid red; }",
				".d { color: var(--gray-900); }",
			].join("\n"),
		);
		expect(swatches(p)).toEqual([
			{ text: "var(--nope, rgb(0 128 0 / 25%))", color: { red: 0, green: 0.502, blue: 0, alpha: 0.25 } },
			{ text: "var(--gray-900)", color: { red: 0.067, green: 0.094, blue: 0.153, alpha: 1 } },
		]);
	});

	test("nested var() in a fallback yields one swatch", () => {
		const { open } = setup("next-app", NEXT);
		const p = open("src/components/New.module.css", ".a { color: var(--nope, var(--gray-900)); }");
		expect(texts(p)).toEqual(["var(--nope, var(--gray-900))"]);
	});

	test("cycles resolve to nothing", () => {
		const { open } = setup("next-app");
		const p = open("src/components/New.module.css", ".a { --x: var(--y); --y: var(--x); color: var(--x); }");
		expect(documentColors(p)).toEqual([]);
	});

	test("vars from the file itself and an aliased @import", () => {
		const { open } = setup("variables");
		const p = open("src/styles/card.module.css");
		expect(swatches(p)).toEqual([
			{ text: "var(--theme-red)", color: { red: 1, green: 0, blue: 0, alpha: 1 } },
		]);
		const local = open("src/styles/New.module.css", ".a { --c: hsl(120 100% 50%); color: var(--c); }");
		expect(swatches(local)).toEqual([{ text: "var(--c)", color: { red: 0, green: 1, blue: 0, alpha: 1 } }]);
	});

	test("monorepo: global vars are scoped per package root", () => {
		const { open } = setup("monorepo", { globalFiles: ["src/globals.css"] });
		const text = ".a { color: var(--web-color); }";
		open("apps/web/src/globals.css", ":root { --web-color: #00ff00; }");
		expect(texts(open("apps/web/src/components/New.module.css", text))).toEqual(["var(--web-color)"]);
		expect(documentColors(open("apps/docs/app/New.module.css", text))).toEqual([]);
	});

	test("node_modules vars only with nodeModules.enabled", () => {
		const settings = { globalFiles: ["src/globals.css"] };
		expect(documentColors(setup("aliases", settings).open("src/styles/a.module.css"))).toEqual([]);
		const on = setup("aliases", { ...settings, nodeModules: { enabled: true } });
		expect(swatches(on.open("src/styles/a.module.css"))).toEqual([
			{ text: "var(--op-blue)", color: { red: 0.2, green: 0.604, blue: 0.941, alpha: 1 } },
		]);
	});
});

describe("documentColors in scripts", () => {
	test("string literals in JSX style props", () => {
		const { open } = setup("next-app", NEXT);
		expect(swatches(open(BUTTON_TSX))).toEqual([{ text: "var(--brand)", color: BRAND }]);
	});

	test("template literals; comments and non-strings ignored", () => {
		const { open } = setup("next-app", NEXT);
		const p = open(
			BUTTON_TSX,
			[
				'import styles from "./Button.module.css";',
				"const a = `border: 1px solid var(--accent)`;",
				"// 'var(--brand)'",
				"const b = var(--brand);",
				"const c = 'var(--space-2)';",
			].join("\n"),
		);
		expect(swatches(p)).toEqual([
			{ text: "var(--accent)", color: { red: 1, green: 0, blue: 0, alpha: 0.5 } },
		]);
	});

	test("vars reached through relative and alias CSS module imports", () => {
		const { open } = setup("variables");
		expect(texts(open("src/components/Aliased.tsx"))).toEqual(["var(--theme-red)"]);
		const p = open(
			"src/components/Relative.tsx",
			'import s from "../styles/card.module.css";\nconst c = "var(--theme-red)";',
		);
		expect(texts(p)).toEqual(["var(--theme-red)"]);
		expect(documentColors(open("src/components/Loose.tsx", 'const c = "var(--theme-red)";'))).toEqual([]);
	});

	test("variables.tsxStrings = false turns off script swatches only", () => {
		const { open } = setup("next-app", { ...NEXT, ...vars({ tsxStrings: false }) });
		expect(documentColors(open(BUTTON_TSX))).toEqual([]);
		expect(documentColors(open(BUTTON_CSS)).length).toBeGreaterThan(0);
	});
});

describe("settings via router", () => {
	test("on by default", () => {
		const { open } = setup("next-app", NEXT);
		expect(colors(open(BUTTON_CSS)).length).toBeGreaterThan(0);
		expect(colors(open(BUTTON_TSX))).toHaveLength(1);
	});

	test("variables.colors = false", () => {
		const { open } = setup("next-app", { ...NEXT, ...vars({ colors: false }) });
		expect(colors(open(BUTTON_CSS))).toEqual([]);
		expect(colors(open(BUTTON_TSX))).toEqual([]);
	});

	test("variables.enabled = false", () => {
		const { open } = setup("next-app", { ...NEXT, ...vars({ enabled: false }) });
		expect(colors(open(BUTTON_CSS))).toEqual([]);
	});
});
