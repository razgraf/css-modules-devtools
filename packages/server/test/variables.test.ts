import { describe, expect, test } from "bun:test";
import { type CompletionItem, CompletionItemKind, type Hover, MarkupKind } from "vscode-languageserver";
import type { DocParams } from "../src/context";
import { scriptVarRefs, varDefinition, varHover } from "../src/features/variables";
import { completion, definition, hover } from "../src/router";
import { cursorAt, read, setup } from "./helpers";

const NEXT = { globalFiles: ["src/app/globals.css"] };
const BUTTON_CSS = "src/components/Button.module.css";
const BUTTON_TSX = "src/components/Button.tsx";

const labels = (items: CompletionItem[]) => items.map((i) => i.label);
const item = (items: CompletionItem[], label: string) => items.find((i) => i.label === label);
const markdown = (h: Hover | undefined) => {
	const contents = h?.contents;
	return contents && typeof contents === "object" && "kind" in contents ? contents.value : "";
};
const files = (p: DocParams) =>
	(varDefinition(p) ?? []).map((l) => `${l.uri.split("/fixtures/")[1]}:${l.range.start.line}`);

describe("varCompletions", () => {
	test("lists global vars with resolved value and color kind in a module", () => {
		const { open } = setup("next-app", NEXT);
		const items = completion(open("src/components/New.module.css", ".x { color: var(--|) }"));
		expect(labels(items)).toEqual(
			expect.arrayContaining(["--bg", "--fg", "--brand", "--brand-alias", "--accent", "--space-2"]),
		);

		const brand = item(items, "--brand");
		expect(brand?.kind).toBe(CompletionItemKind.Color);
		expect(brand?.detail).toBe("oklch(62% 0.2 255)");
		expect(brand?.documentation).toBe("#0c84fa");
		expect(brand?.labelDetails?.description).toBe("colors.css");

		const alias = item(items, "--brand-alias");
		expect(alias?.kind).toBe(CompletionItemKind.Color);
		expect(alias?.detail).toBe("oklch(62% 0.2 255)");

		const accent = item(items, "--accent");
		expect(accent?.detail).toBe("rgb(255 0 0 / 50%)");
		expect(accent?.documentation).toBe("rgba(255, 0, 0, 0.50)");

		const bg = item(items, "--bg");
		expect(bg?.detail).toBe("#ffffff");
		expect(bg?.labelDetails?.description).toBe("globals.css");

		const space = item(items, "--space-2");
		expect(space?.kind).toBe(CompletionItemKind.Variable);
		expect(space?.detail).toBe("calc(var(--space-1) * 2)");
		expect(space?.documentation).toEqual({
			kind: MarkupKind.Markdown,
			value: "`--space-2: calc(var(--space-1) * 2)` · `:root` · tokens.css",
		});
	});

	test("filters by prefix and replaces it", () => {
		const { open } = setup("next-app", NEXT);
		const items = completion(open("src/components/New.module.css", ".x {\n\tcolor: var(--br|);\n}"));
		expect(labels(items).sort()).toEqual(["--brand", "--brand-alias"]);
		expect(item(items, "--brand")?.textEdit).toEqual({
			range: { start: { line: 1, character: 12 }, end: { line: 1, character: 16 } },
			newText: "--brand",
		});
	});

	test("excludes vars declared only in the current .css file", () => {
		const { open } = setup("next-app", NEXT);
		const text = ".a { --local-only: red; --brand: blue; color: var(--|); }";
		for (const file of ["src/components/New.module.css", "src/app/page.css"]) {
			const names = labels(completion(open(file, text)));
			expect(names).not.toContain("--local-only");
			expect(names).toContain("--brand");
		}
	});

	test("keeps current-file vars in scripts", () => {
		const { open } = setup("variables");
		const names = labels(
			completion(
				open(
					"src/components/Aliased.tsx",
					'import styles from "@/styles/card.module.css";\nconst s = { padding: "var(--|" };',
				),
			),
		);
		expect(names.sort()).toEqual(["--card-pad", "--theme-gap", "--theme-red"]);
	});

	test("script strings and template literals through relative and alias imports", () => {
		const { open } = setup("variables");
		const rel = completion(
			open(
				"src/components/Relative.tsx",
				'import s from "../styles/card.module.css";\nconst x = `var(--theme-|`;',
			),
		);
		expect(labels(rel).sort()).toEqual(["--theme-gap", "--theme-red"]);
		expect(item(rel, "--theme-red")?.documentation).toBe("#ff0000");
		const none = completion(open("src/components/Loose.tsx", 'const x = "var(--|";'));
		expect(none).toEqual([]);
	});

	test("monorepo: global vars are scoped per package root", () => {
		const { open } = setup("monorepo", { globalFiles: ["src/globals.css"] });
		const web = labels(completion(open("apps/web/src/components/New.module.css", ".x { margin: var(--|) }")));
		expect(web).toContain("--web-only");
		const docs = labels(completion(open("apps/docs/app/New.module.css", ".x { margin: var(--|) }")));
		expect(docs).not.toContain("--web-only");
	});

	test("node_modules vars only with nodeModules.enabled", () => {
		const text = ".x { color: var(--op|) }";
		const off = setup("aliases", { globalFiles: ["src/globals.css"] });
		expect(labels(completion(off.open("src/styles/New.module.css", text)))).toEqual([]);
		const on = setup("aliases", { globalFiles: ["src/globals.css"], nodeModules: { enabled: true } });
		const items = completion(on.open("src/styles/New.module.css", text));
		expect(labels(items)).toEqual(["--op-blue"]);
		expect(item(items, "--op-blue")?.documentation).toBe("#339af0");
	});
});

describe("varDefinition", () => {
	test("css: every declaration of the var under the cursor", () => {
		const { open } = setup("next-app", NEXT);
		const css = read("next-app", BUTTON_CSS);
		const expected = ["next-app/src/components/Button.module.css:33", "next-app/src/app/colors.css:3"];
		expect(files(open(BUTTON_CSS, cursorAt(css, "--brand)", 3)))).toEqual(expected);
		expect(files(open(BUTTON_CSS, cursorAt(css, "var(--brand)", 1)))).toEqual(expected);
		expect(files(open(BUTTON_CSS, cursorAt(css, "--space-2", 2)))).toEqual(["next-app/src/app/tokens.css:4"]);
	});

	test("css: nothing off a var() or for unknown vars", () => {
		const { open } = setup("next-app", NEXT);
		const css = read("next-app", BUTTON_CSS);
		expect(varDefinition(open(BUTTON_CSS, cursorAt(css, "padding", 2)))).toBeUndefined();
		expect(varDefinition(open(BUTTON_CSS, cursorAt(css, "--brand:", 2)))).toBeUndefined();
		expect(
			varDefinition(open("src/components/New.module.css", ".a { color: var(--no|pe); }")),
		).toBeUndefined();
	});

	test("css: innermost reference wins in a fallback", () => {
		const { open } = setup("next-app", NEXT);
		const p = open("src/components/New.module.css", ".a { color: var(--nope, var(--gray|-900)); }");
		expect(files(p)).toEqual(["next-app/src/app/colors.css:5"]);
	});

	test("css: through an aliased @import", () => {
		const { open } = setup("variables");
		const css = read("variables", "src/styles/card.module.css");
		expect(files(open("src/styles/card.module.css", cursorAt(css, "--theme-red", 3)))).toEqual([
			"variables/src/theme.css:1",
		]);
	});

	test("scripts: var() inside strings via alias and relative imports", () => {
		const { open } = setup("variables");
		const aliased = read("variables", "src/components/Aliased.tsx");
		expect(files(open("src/components/Aliased.tsx", cursorAt(aliased, "--theme-red", 4)))).toEqual([
			"variables/src/theme.css:1",
		]);
		const relative = read("variables", "src/components/Relative.tsx");
		expect(files(open("src/components/Relative.tsx", cursorAt(relative, "--theme-gap", 4)))).toEqual([
			"variables/src/theme.css:2",
		]);
	});

	test("scripts: global vars and nothing outside strings or in comments", () => {
		const { open } = setup("next-app", NEXT);
		const tsx = read("next-app", BUTTON_TSX);
		expect(files(open(BUTTON_TSX, cursorAt(tsx, "--brand", 2)))).toContain("next-app/src/app/colors.css:3");
		expect(varDefinition(open(BUTTON_TSX, "// see 'var(--br|and)'\n"))).toBeUndefined();
		expect(varDefinition(open(BUTTON_TSX, "const v = var(--br|and);\n"))).toBeUndefined();
	});

	test("scripts: an apostrophe in JSX text before the string", () => {
		const { open } = setup("next-app", NEXT);
		const p = open(BUTTON_TSX, "const a = <p>Don't <b title='var(--br|and)' /></p>;\n");
		expect(files(p)).toContain("next-app/src/app/colors.css:3");
	});

	test("monorepo: global declarations from the package's own globals", () => {
		const { open } = setup("monorepo", { globalFiles: ["src/globals.css"] });
		const css = read("monorepo", "apps/web/src/components/Hero.module.css");
		expect(files(open("apps/web/src/components/Hero.module.css", cursorAt(css, "--web-only)", 2)))).toEqual([
			"monorepo/apps/web/src/components/Hero.module.css:10",
			"monorepo/apps/web/src/globals.css:1",
		]);
		const docs = open("apps/docs/app/New.module.css", ".a { margin: var(--web|-only); }");
		expect(varDefinition(docs)).toBeUndefined();
	});

	test("node_modules declarations only with nodeModules.enabled", () => {
		const css = read("aliases", "src/styles/a.module.css");
		const text = cursorAt(css, "--op-blue", 2);
		const off = setup("aliases", { globalFiles: ["src/globals.css"] });
		expect(varDefinition(off.open("src/styles/a.module.css", text))).toBeUndefined();
		const on = setup("aliases", { globalFiles: ["src/globals.css"], nodeModules: { enabled: true } });
		expect(files(on.open("src/styles/a.module.css", text))).toEqual([
			"aliases/node_modules/open-props/style.css:1",
		]);
	});
});

describe("varHover", () => {
	test("lists declarations with selector and file, plus resolved value", () => {
		const { open } = setup("next-app", NEXT);
		const css = read("next-app", BUTTON_CSS);
		const h = varHover(open(BUTTON_CSS, cursorAt(css, "--brand-alias", 3)));
		expect(markdown(h)).toBe(
			"`--brand-alias: var(--brand)` · `:root` · colors.css\n\nResolved: `oklch(62% 0.2 255)`",
		);
		expect(h?.range).toEqual({ start: { line: 7, character: 8 }, end: { line: 7, character: 26 } });
	});

	test("multiple declarations, no resolved line when it equals the winner", () => {
		const { open } = setup("next-app", NEXT);
		const css = read("next-app", BUTTON_CSS);
		const value = markdown(varHover(open(BUTTON_CSS, cursorAt(css, "--brand)", 2))));
		expect(value).toBe(
			"`--brand: white` · `:global .theme-dark` · Button.module.css  \n`--brand: oklch(62% 0.2 255)` · `:root` · colors.css",
		);
	});

	test("caps the list", () => {
		const { open } = setup("next-app", NEXT);
		const decls = Array.from({ length: 7 }, (_, i) => `.s${i} { --many: ${i}px; }`).join("\n");
		const value = markdown(
			varHover(open("src/components/New.module.css", `${decls}\n.a { gap: var(--ma|ny); }`)),
		);
		expect(value.split("\n").filter((l) => l.startsWith("`--many"))).toHaveLength(5);
		expect(value).toContain("…and 2 more");
	});

	test("scripts", () => {
		const { open } = setup("next-app", NEXT);
		const tsx = read("next-app", BUTTON_TSX);
		expect(markdown(varHover(open(BUTTON_TSX, cursorAt(tsx, "--brand", 2))))).toContain(
			"`--brand: oklch(62% 0.2 255)` · `:root` · colors.css",
		);
	});
});

describe("scriptVarRefs", () => {
	test("strings, templates and fallbacks; skips comments and code", () => {
		const text = [
			'const a = "var(--a, rgb(0 0 0 / 50%))";',
			"const b = `x ${y} var(--b)`;",
			"// 'var(--c)'",
			'/* "var(--d)" */',
			"const e = var(--e);",
			"const f = 'var(--f';",
		].join("\n");
		expect(scriptVarRefs(text).map((r) => [r.name, r.fallback, text.slice(r.start, r.end)])).toEqual([
			["--a", "rgb(0 0 0 / 50%)", "var(--a, rgb(0 0 0 / 50%))"],
			["--b", undefined, "var(--b)"],
			["--f", undefined, "var(--f"],
		]);
	});

	test("quotes in JSX text and regexes don't shift string boundaries", () => {
		const refs = (text: string) => scriptVarRefs(text).map((r) => text.slice(r.start, r.end));
		expect(refs("<p>Don't</p> <b title='var(--a)' />")).toEqual(["var(--a)"]);
		expect(refs('<p>A 5" screen</p> <b title="var(--b)" />')).toEqual(["var(--b)"]);
		expect(refs("<p>It's var(--c), isn't it</p>")).toEqual([]);
		expect(refs("const r = /'/; const s = 'var(--d)';")).toEqual(["var(--d)"]);
		expect(refs("const t = `${a} var(--e) ${b} var(--f, red)`;")).toEqual(["var(--e)", "var(--f, red)"]);
	});
});

describe("settings via router", () => {
	const css = read("next-app", BUTTON_CSS);
	const tsx = read("next-app", BUTTON_TSX);

	test("variables.enabled = false turns off completion, definition and hover", () => {
		const { open } = setup("next-app", {
			...NEXT,
			variables: { enabled: false, tsxStrings: true, colors: true },
		});
		expect(completion(open("src/components/New.module.css", ".x { color: var(--|) }"))).toEqual([]);
		expect(completion(open(BUTTON_TSX, 'const s = "var(--|";'))).toEqual([]);
		expect(definition(open(BUTTON_CSS, cursorAt(css, "--brand)", 2)))).toBeUndefined();
		expect(hover(open(BUTTON_CSS, cursorAt(css, "--brand)", 2)))).toBeUndefined();
	});

	test("defaults route to var features", () => {
		const { open } = setup("next-app", NEXT);
		expect(
			completion(open("src/components/New.module.css", ".x { color: var(--|) }")).length,
		).toBeGreaterThan(0);
		expect(definition(open(BUTTON_CSS, cursorAt(css, "--brand)", 2)))?.length).toBe(2);
		expect(markdown(hover(open(BUTTON_CSS, cursorAt(css, "--brand)", 2))))).toContain("--brand");
		expect(definition(open(BUTTON_TSX, cursorAt(tsx, "--brand", 2)))?.length).toBe(2);
	});

	test("variables.tsxStrings = false only turns off scripts", () => {
		const { open } = setup("next-app", {
			...NEXT,
			variables: { enabled: true, tsxStrings: false, colors: true },
		});
		expect(completion(open(BUTTON_TSX, 'const s = "var(--|";'))).toEqual([]);
		expect(definition(open(BUTTON_TSX, cursorAt(tsx, "--brand", 2)))).toBeUndefined();
		expect(hover(open(BUTTON_TSX, cursorAt(tsx, "--brand", 2)))).toBeUndefined();
		expect(
			completion(open("src/components/New.module.css", ".x { color: var(--|) }")).length,
		).toBeGreaterThan(0);
	});
});
