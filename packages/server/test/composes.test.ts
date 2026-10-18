import { describe, expect, spyOn, test } from "bun:test";
import { cssContext } from "@css-modules-devtools/core";
import { type CompletionItem, type Hover, type Location, LocationLink } from "vscode-languageserver";
import type { DocParams } from "../src/context";
import { composesCompletions, composesDefinition, composesHover } from "../src/features/composes";
import { toUri } from "../src/lsp";
import { completion, definition, hover } from "../src/router";
import { cursorAt, fixture, read, setup } from "./helpers";

const BUTTON = "src/components/Button.module.css";
const CARD = "src/components/Card.module.css";
const BASE = "src/styles/base.module.css";

function complete(p: DocParams): CompletionItem[] {
	const c = cssContext(p.text, p.offset);
	if (c?.kind !== "composesName" && c?.kind !== "composesPath") throw new Error("not a composes context");
	return composesCompletions(p, c);
}

const labels = (items: CompletionItem[]) => items.map((i) => i.label).sort();

const newTexts = (items: CompletionItem[]) =>
	items.map((i) => (i.textEdit && "newText" in i.textEdit ? i.textEdit.newText : "")).sort();

const hoverText = (h: Hover | undefined) =>
	h && typeof h.contents === "object" && "value" in h.contents ? h.contents.value : "";

const target = (locs: Location[] | LocationLink[] | undefined) =>
	(locs ?? []).map((l) => {
		const { uri, range } = LocationLink.is(l) ? { uri: l.targetUri, range: l.targetRange } : l;
		return `${uri.replace(/^file:\/\//, "")}:${range.start.line}:${range.start.character}`;
	});

describe("composes name completion", () => {
	test("same file: local classes without the owner", () => {
		const { open } = setup("next-app");
		const p = open(BASE, cursorAt(read("next-app", BASE), "composes: reset", "composes: re".length));
		const items = complete(p);
		expect(labels(items)).toEqual(["reset"]);
		const edit = items[0]?.textEdit;
		expect(edit && "range" in edit ? edit.range : undefined).toEqual({
			start: { line: 6, character: 11 },
			end: { line: 6, character: 13 },
		});
		expect(items[0]?.detail).toBe("base.module.css:1");
	});

	test("alias target", () => {
		const { open } = setup("next-app");
		const p = open(BUTTON, cursorAt(read("next-app", BUTTON), "focusable from", 0));
		expect(labels(complete(p))).toEqual(["focusable", "reset"]);
	});

	test("relative target lists local classes only", () => {
		const { open } = setup("next-app");
		const p = open(CARD, cursorAt(read("next-app", CARD), "button from", 0));
		expect(labels(complete(p))).toEqual(["button", "icon", "primary-action"]);
	});

	test("monorepo package export target", () => {
		const { open } = setup("monorepo");
		const file = "apps/web/src/components/Hero.module.css";
		const p = open(file, cursorAt(read("monorepo", file), "surface from", 0));
		expect(labels(complete(p))).toEqual(["surface"]);
	});

	test("from global uses global scope classes", () => {
		const { open } = setup("next-app", { globalFiles: ["src/app/globals.css"] });
		const p = open(CARD, ".card {\n\tcomposes: c| from global;\n}\n");
		expect(labels(complete(p))).toEqual(["container"]);
	});

	test("unresolved target yields nothing", () => {
		const { open } = setup("next-app");
		const p = open(CARD, '.card {\n\tcomposes: | from "./missing.module.css";\n}\n');
		expect(complete(p)).toEqual([]);
	});

	test("router honours completion.enabled", () => {
		const text = cursorAt(read("next-app", CARD), "button from", 0);
		expect(completion(setup("next-app").open(CARD, text)).length).toBeGreaterThan(0);
		expect(completion(setup("next-app", { completion: { enabled: false } }).open(CARD, text))).toEqual([]);
	});
});

describe("composes path completion", () => {
	const inCard = (prefix: string) => `.card {\n\tcomposes: x from "${prefix}|";\n}\n`;

	test("relative: sibling modules, excluding the current file", () => {
		const { open } = setup("next-app");
		const items = complete(open(CARD, inCard("./")));
		expect(newTexts(items)).toEqual(["./Button.module.css"]);
		const edit = items[0]?.textEdit;
		expect(edit && "range" in edit ? edit.range.start.character : -1).toBe(19);
	});

	test("relative: parent directory lists folders", () => {
		const { open } = setup("next-app");
		expect(newTexts(complete(open(CARD, inCard("../"))))).toEqual([
			"../app/",
			"../components/",
			"../styles/",
		]);
		expect(newTexts(complete(open(CARD, inCard("../styles/"))))).toEqual(["../styles/base.module.css"]);
		expect(newTexts(complete(open(CARD, inCard(".."))))).toContain("../styles/");
	});

	test("alias: tsconfig paths without baseUrl", () => {
		const { open } = setup("next-app");
		expect(newTexts(complete(open(CARD, inCard("@/"))))).toEqual([
			"@/components/Button.module.css",
			"@/styles/base.module.css",
		]);
		expect(newTexts(complete(open(CARD, inCard("@/st"))))).toEqual(["@/styles/base.module.css"]);
	});

	test("empty prefix offers relative entries and aliases", () => {
		const { open } = setup("next-app");
		const texts = newTexts(complete(open(CARD, inCard(""))));
		expect(texts).toContain("./Button.module.css");
		expect(texts).toContain("@/styles/base.module.css");
	});

	test("alias: baseUrl paths, package imports and pathAlias setting", () => {
		const file = "src/theme/theme.module.css";
		const theme = setup("aliases", { pathAlias: { $styles: "${workspaceFolder}/src/styles" } });
		const at = (prefix: string) => `.x {\n\tcomposes: y from "${prefix}|";\n}\n`;
		expect(newTexts(complete(theme.open(file, at("~"))))).toEqual(["~styles/a.module.css"]);
		expect(newTexts(complete(theme.open(file, at("#"))))).toEqual(["#styles/a.module.css"]);
		expect(newTexts(complete(theme.open(file, at("$"))))).toEqual(["$styles/a.module.css"]);
	});

	test("alias: tsconfig paths target outside the package root", () => {
		const { open } = setup("shared-paths");
		const file = "apps/site/src/Page.module.css";
		const items = complete(open(file, `.page {\n\tcomposes: surface from "@shared/|";\n}\n`));
		expect(newTexts(items)).toEqual(["@shared/ui.module.css"]);
	});

	test("monorepo: solution-style tsconfig alias", () => {
		const { open } = setup("monorepo");
		const file = "apps/docs/app/Other.module.css";
		expect(newTexts(complete(open(file, `.x {\n\tcomposes: page from "@/|";\n}\n`)))).toEqual([
			"@/Page.module.css",
		]);
	});

	test("alias candidates come from the project's shared module walk", () => {
		const { ctx, open } = setup("next-app");
		const walk = spyOn(ctx.project, "moduleFiles");
		complete(open(CARD, inCard("@/")));
		expect(walk).toHaveBeenCalledWith(fixture("next-app"), fixture("next-app", CARD), true);
		expect(walk).toHaveBeenCalledWith(fixture("next-app", "src"), fixture("next-app", CARD), true);
	});

	test("alias targets that are folders of workspace packages", () => {
		const { open } = setup("alias-packages");
		const items = complete(open("src/Page.module.css", `.page {\n\tcomposes: button from "@pkgs/|";\n}\n`));
		expect(newTexts(items)).toContain("@pkgs/ui/button.module.css");
	});

	test("monorepo: workspace package exports", () => {
		const { open } = setup("monorepo");
		const file = "apps/web/src/components/Hero.module.css";
		const items = complete(open(file, `.hero {\n\tcomposes: surface from "@repo/|";\n}\n`));
		expect(newTexts(items)).toEqual(["@repo/ui/shared.module.css"]);
	});
});

describe("composes definition", () => {
	test("alias target class", () => {
		const { open } = setup("next-app");
		const p = open(BUTTON, cursorAt(read("next-app", BUTTON), "focusable from", 2));
		expect(target(composesDefinition(p))).toEqual([`${fixture("next-app", BASE)}:5:1`]);
	});

	test("same-file class", () => {
		const { open } = setup("next-app");
		const p = open(BASE, cursorAt(read("next-app", BASE), "composes: reset", "composes: ".length + 1));
		expect(target(composesDefinition(p))).toEqual([`${fixture("next-app", BASE)}:0:1`]);
	});

	test("relative target lists every selector of the class", () => {
		const { open } = setup("next-app");
		const p = open(CARD, cursorAt(read("next-app", CARD), "button from", 1));
		const file = fixture("next-app", BUTTON);
		expect(target(composesDefinition(p))).toEqual([
			`${file}:0:1`,
			`${file}:6:1`,
			`${file}:23:2`,
			`${file}:28:18`,
		]);
	});

	test("from global", () => {
		const { open } = setup("next-app", { globalFiles: ["src/app/globals.css"] });
		const p = open(CARD, ".card {\n\tcomposes: cont|ainer from global;\n}\n");
		expect(target(composesDefinition(p))).toEqual([`${fixture("next-app", "src/app/globals.css")}:11:1`]);
	});

	test("monorepo package export", () => {
		const { open } = setup("monorepo");
		const file = "apps/web/src/components/Hero.module.css";
		const p = open(file, cursorAt(read("monorepo", file), "surface from", 1));
		expect(target(composesDefinition(p))).toEqual([
			`${fixture("monorepo", "packages/ui/src/shared.module.css")}:0:1`,
		]);
	});

	test("path opens the file", () => {
		const { open } = setup("next-app");
		const text = cursorAt(read("next-app", BUTTON), "styles/base", 0);
		const p = open(BUTTON, text);
		const links = (composesDefinition(p) ?? []).filter(LocationLink.is);
		const start = text.replace("|", "").indexOf("@/styles/base.module.css");
		expect(links.map((l) => [l.targetUri, l.targetRange.start, l.originSelectionRange])).toEqual([
			[
				toUri(fixture("next-app", BASE)),
				{ line: 0, character: 0 },
				{
					start: p.doc.positionAt(start),
					end: p.doc.positionAt(start + "@/styles/base.module.css".length),
				},
			],
		]);
	});

	test("outside composes yields nothing", () => {
		const { open } = setup("next-app");
		expect(
			composesDefinition(open(BUTTON, cursorAt(read("next-app", BUTTON), "padding", 1))),
		).toBeUndefined();
	});

	test("router honours definition.enabled", () => {
		const text = cursorAt(read("next-app", BUTTON), "focusable from", 2);
		expect(definition(setup("next-app").open(BUTTON, text))).toHaveLength(1);
		expect(
			definition(setup("next-app", { definition: { enabled: false } }).open(BUTTON, text)),
		).toBeUndefined();
	});
});

describe("composes hover", () => {
	test("name shows the target class rules", () => {
		const { open } = setup("next-app");
		const p = open(BUTTON, cursorAt(read("next-app", BUTTON), "focusable from", 2));
		const h = composesHover(p);
		expect(hoverText(h)).toBe(
			"**.focusable** · base.module.css\n```css\n.focusable {\n  composes: reset;\n  outline: none;\n}\n```",
		);
		expect(h?.range).toEqual({ start: { line: 1, character: 11 }, end: { line: 1, character: 20 } });
	});

	test("relative target includes wrappers", () => {
		const { open } = setup("next-app");
		const value = hoverText(composesHover(open(CARD, cursorAt(read("next-app", CARD), "button from", 1))));
		expect(value).toStartWith("**.button** · Button.module.css");
		expect(value).toContain("@media (min-width: 40rem) {\n  .button {");
		expect(value).toContain(".button:hover {");
	});

	test("truncates after hover.maxLines with a link to the definition", () => {
		const { open } = setup("next-app", { hover: { enabled: true, maxLines: 3 } });
		const value = hoverText(composesHover(open(CARD, cursorAt(read("next-app", CARD), "button from", 1))));
		expect(value).toBe(
			[
				"**.button** · Button.module.css",
				"```css",
				".button {",
				'  composes: focusable from "@/styles/base.module.css";',
				"  color: var(--brand);",
				"…",
				"```",
				"",
				`[Go to definition](file://${fixture("next-app", BUTTON)}#L1)`,
			].join("\n"),
		);

		const fits = setup("next-app", { hover: { enabled: true, maxLines: 5 } });
		const p = fits.open(BUTTON, cursorAt(read("next-app", BUTTON), "focusable from", 2));
		expect(hoverText(composesHover(p))).not.toContain("…");
		const unlimited = setup("next-app", { hover: { enabled: true, maxLines: 0 } });
		const q = unlimited.open(CARD, cursorAt(read("next-app", CARD), "button from", 1));
		expect(hoverText(composesHover(q))).not.toContain("Go to definition");
	});

	test("monorepo package export", () => {
		const { open } = setup("monorepo");
		const file = "apps/web/src/components/Hero.module.css";
		const value = hoverText(composesHover(open(file, cursorAt(read("monorepo", file), "surface from", 1))));
		expect(value).toContain("**.surface** · shared.module.css");
		expect(value).toContain("border-radius: 8px;");
	});

	test("path shows the resolved file", () => {
		const { open } = setup("next-app");
		const p = open(BUTTON, cursorAt(read("next-app", BUTTON), "styles/base", 0));
		expect(hoverText(composesHover(p))).toBe("`src/styles/base.module.css`");
	});

	test("router honours hover.enabled", () => {
		const text = cursorAt(read("next-app", BUTTON), "focusable from", 2);
		expect(hover(setup("next-app").open(BUTTON, text))).toBeDefined();
		const off = setup("next-app", { hover: { enabled: false, maxLines: 30 } });
		expect(hover(off.open(BUTTON, text))).toBeUndefined();
	});
});
