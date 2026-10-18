import { describe, expect, test } from "bun:test";
import { type Convention, scriptContext } from "@css-modules-devtools/core";
import { type CompletionItem, type Hover, type Location, MarkupContent } from "vscode-languageserver";
import type { DocParams } from "../src/context";
import { classCompletions, classDefinition, classHover } from "../src/features/classes";
import { toUri } from "../src/lsp";
import * as router from "../src/router";
import { cursorAt, fixture, read, setup } from "./helpers";

const button = read("next-app", "src/components/Button.tsx");
const card = read("next-app", "src/components/Card.tsx");

const BUTTON_CSS = fixture("next-app", "src/components/Button.module.css");
const BASE_CSS = fixture("next-app", "src/styles/base.module.css");

function complete(p: DocParams): CompletionItem[] | undefined {
	const c = scriptContext(p.text, p.offset);
	if (!c || c.kind === "var") throw new Error("no class completion context");
	return classCompletions(p, c);
}

const labels = (items: CompletionItem[] | undefined) => (items ?? []).map((i) => i.label).sort();

const byLabel = (items: CompletionItem[] | undefined, label: string) => {
	const found = items?.find((i) => i.label === label);
	if (!found) throw new Error(`no item ${label}`);
	return found;
};

const edit = (i: CompletionItem) => {
	if (!i.textEdit || !("range" in i.textEdit)) throw new Error("expected a TextEdit");
	return i.textEdit;
};

const at = (loc: Location) => [loc.uri, loc.range.start.line, loc.range.start.character];

const markdown = (h: Hover | undefined) => (h && MarkupContent.is(h.contents) ? h.contents.value : "");

const component = (imports: string, body: string) =>
	`${imports}\n\nexport const C = () => <div className={${body}} />;\n`;

describe("completion", () => {
	const { open } = setup("next-app");

	test("member access lists local exported classes only", () => {
		const items = complete(open("src/components/Button.tsx", cursorAt(button, "styles.icon", 7)));
		expect(labels(items)).toEqual(["button", "icon", "primary-action"]);
	});

	test("items replace from the dot; kebab keys switch to bracket form", () => {
		const text = component('import styles from "./Button.module.css";', "styles.pr|");
		const p = open("src/components/X.tsx", text);
		const items = complete(p);
		const dot = p.text.indexOf("styles.") + "styles".length;

		const plain = byLabel(items, "button");
		expect(edit(plain).newText).toBe(".button");
		expect(edit(plain).range).toEqual({ start: p.doc.positionAt(dot), end: p.doc.positionAt(p.offset) });
		expect(plain.filterText).toBe(".button");

		const kebab = byLabel(items, "primary-action");
		expect(edit(kebab).newText).toBe("['primary-action']");
		expect(edit(kebab).range.start).toEqual(p.doc.positionAt(dot));
		expect(kebab.filterText).toBe(".primary-action");
	});

	test("all member items share one range start, so the client ranks them by sortText/label, not by kebab-ness", () => {
		const p = open(
			"src/components/X.tsx",
			component('import styles from "./Button.module.css";', "styles.|"),
		);
		const starts = new Set((complete(p) ?? []).map((i) => JSON.stringify(edit(i).range.start)));
		expect(starts.size).toBe(1);
	});

	test("optional chaining keeps `?.` before the bracket", () => {
		const text = component('import styles from "./Button.module.css";', "styles?.|");
		const p = open("src/components/X.tsx", text);
		const kebab = byLabel(complete(p), "primary-action");
		expect(edit(kebab).newText).toBe(".['primary-action']");
		expect(p.doc.getText(edit(kebab).range)).toBe(".");
		expect(edit(byLabel(complete(p), "button")).newText).toBe(".button");
	});

	test("bracket access inserts the bare key", () => {
		const p = open("src/components/Button.tsx", cursorAt(button, 'styles["primary-action"]', 10));
		const item = byLabel(complete(p), "primary-action");
		expect(edit(item).newText).toBe("primary-action");
		expect(p.doc.getText(edit(item).range)).toBe("pr");
	});

	test("detail is the module file and first declaration line; documentation waits for resolve", () => {
		const { ctx, open: o } = setup("next-app");
		const items = complete(o("src/components/Button.tsx", cursorAt(button, "styles.icon", 7)));
		const item = byLabel(items, "button");
		expect(item.detail).toBe("Button.module.css:1");
		expect(byLabel(items, "icon").detail).toBe("Button.module.css:18");
		expect(item.documentation).toBeUndefined();
		expect(item.data).toEqual({ kind: "class", file: BUTTON_CSS, name: "button" });
		expect(router.resolveCompletion(ctx, item).documentation).toEqual({
			kind: "markdown",
			value:
				'```css\n.button {\n  composes: focusable from "@/styles/base.module.css";\n  color: var(--brand);\n  padding: var(--space-2);\n}\n```',
		});
	});

	test("resolve maps convention keys back to the class; foreign items pass through", () => {
		const { ctx, open: o } = setup("next-app", { classNameConvention: "camelCaseOnly" });
		const text = component('import styles from "./Button.module.css";', "styles.|");
		const item = byLabel(complete(o("src/components/X.tsx", text)), "primaryAction");
		expect(item.data).toEqual({ kind: "class", file: BUTTON_CSS, name: "primary-action" });
		const doc = router.resolveCompletion(ctx, item).documentation;
		expect(MarkupContent.is(doc) ? doc.value : "").toStartWith("```css\n.primary-action {");

		const foreign: CompletionItem = { label: "x", data: { kind: "other" } };
		expect(router.resolveCompletion(ctx, foreign)).toBe(foreign);
		const gone: CompletionItem = { label: "y", data: { kind: "class", file: "/nope.module.css", name: "y" } };
		expect(router.resolveCompletion(ctx, gone)).toBe(gone);
	});

	test("large modules complete without per-item rule formatting", () => {
		const s = setup("next-app");
		const css = Array.from({ length: 5000 }, (_, i) => `.c${i} {\n\tcolor: red;\n}\n`).join("\n");
		s.open("src/components/Button.module.css", css);
		s.ctx.project.cssInfo(BUTTON_CSS);
		const p = s.open(
			"src/components/X.tsx",
			component('import styles from "./Button.module.css";', "styles.|"),
		);
		complete(p);
		const start = performance.now();
		const items = complete(p);
		const elapsed = performance.now() - start;
		expect(items).toHaveLength(5000);
		expect(byLabel(items, "c4999").detail).toBe("Button.module.css:19997");
		// Wall-clock bounds flake on loaded CI machines; opt in with PERF=1.
		if (process.env.PERF === "1") expect(elapsed).toBeLessThan(500);
	});

	test("alias import (tsconfig paths)", () => {
		const text = component('import base from "@/styles/base.module.css";', "base.|");
		const items = complete(open("src/components/X.tsx", text));
		expect(labels(items)).toEqual(["focusable", "reset"]);
		expect(items?.[0]?.detail).toBe("base.module.css:1");
	});

	test("namespace import and require bindings", () => {
		expect(labels(complete(open("src/components/Card.tsx", `${card}\nns.|`)))).toEqual(["card"]);
		expect(labels(complete(open("src/components/Card.tsx", `${card}\nlegacy.|`)))).toEqual([
			"button",
			"icon",
			"primary-action",
		]);
	});

	test("named import specifiers offer identifier keys", () => {
		const p = open("src/components/X.tsx", component('import { | } from "./Button.module.css";', "''"));
		expect(labels(complete(p))).toEqual(["button", "icon"]);
		const q = open(
			"src/components/X.tsx",
			component('import { button, ic| } from "./Card.module.css";', "''"),
		);
		expect(labels(complete(q))).toEqual(["card"]);
	});

	test("half-typed code that doesn't parse still finds the binding", () => {
		const text =
			'import s from "./Button.module.css";\nexport function A() {\n\treturn <div className={s.|\n';
		expect(labels(complete(open("src/components/X.tsx", text)))).toEqual([
			"button",
			"icon",
			"primary-action",
		]);
		const bracket =
			'import s from "./Button.module.css";\nexport function A() {\n\treturn <div className={s[\'|\n';
		expect(labels(complete(open("src/components/X.tsx", bracket)))).toEqual([
			"button",
			"icon",
			"primary-action",
		]);
	});

	test("undefined for non-module objects so auto-import can take over", () => {
		expect(complete(open("src/components/X.tsx", component("", "foo.|")))).toBeUndefined();
		expect(complete(open("src/components/Card.tsx", `${card}\ncard.|`))).toBeUndefined();
		expect(
			complete(
				open("src/components/X.tsx", component('import { x } from "./a";', "import { | } from 'react'")),
			),
		).toBeUndefined();
	});

	test("empty list for an unresolvable module", () => {
		const p = open("src/components/X.tsx", component('import s from "./nope.module.css";', "s.|"));
		expect(complete(p)).toEqual([]);
	});

	test("router respects completion.enabled and tsx.enabled", () => {
		const text = cursorAt(button, "styles.icon", 7);
		expect(labels(router.completion(setup("next-app").open("src/components/Button.tsx", text)))).toContain(
			"button",
		);
		const off = setup("next-app", { completion: { enabled: false } }).open("src/components/Button.tsx", text);
		expect(router.completion(off)).toEqual([]);
		const tsxOff = setup("next-app", { tsx: { enabled: "off" } }).open("src/components/Button.tsx", text);
		expect(router.completion(tsxOff)).toEqual([]);
	});
});

describe("completion in the monorepo", () => {
	const { open } = setup("monorepo");

	test("app alias @/ resolves per app tsconfig", () => {
		const hero = read("monorepo", "apps/web/src/components/Hero.tsx");
		expect(
			labels(complete(open("apps/web/src/components/Hero.tsx", cursorAt(hero, "styles.hero", 7)))),
		).toEqual(["hero", "title"]);
		const page = read("monorepo", "apps/docs/app/Page.tsx");
		expect(labels(complete(open("apps/docs/app/Page.tsx", cursorAt(page, "styles.page", 7))))).toEqual([
			"page",
		]);
	});

	test("exported workspace package", () => {
		const text = component('import ui from "@repo/ui/shared.module.css";', "ui.|");
		const items = complete(open("apps/web/src/components/X.tsx", text));
		expect(labels(items)).toEqual(["surface"]);
		expect(items?.[0]?.detail).toBe("shared.module.css:1");
	});
});

describe("classNameConvention", () => {
	const keys = (convention: Convention, body: string) => {
		const { open } = setup("next-app", { classNameConvention: convention });
		return complete(open("src/components/X.tsx", component('import s from "./Button.module.css";', body)));
	};

	test("camelCase offers both forms", () => {
		const items = keys("camelCase", "s.|");
		expect(labels(items)).toEqual(["button", "icon", "primary-action", "primaryAction"]);
		expect(edit(byLabel(items, "primaryAction")).newText).toBe(".primaryAction");
	});

	test("camelCaseOnly offers camel keys, including for named imports", () => {
		expect(labels(keys("camelCaseOnly", "s.|"))).toEqual(["button", "icon", "primaryAction"]);
		const { open } = setup("next-app", { classNameConvention: "camelCaseOnly" });
		const p = open("src/components/X.tsx", component('import { | } from "./Button.module.css";', "''"));
		expect(labels(complete(p))).toEqual(["button", "icon", "primaryAction"]);
	});

	test("definition and hover map camel keys back to the class", () => {
		const { open } = setup("next-app", { classNameConvention: "camelCase" });
		const p = open(
			"src/components/X.tsx",
			component('import s from "./Button.module.css";', "s.primary|Action"),
		);
		expect(classDefinition(p)?.map(at)).toEqual([[toUri(BUTTON_CSS), 10, 1]]);
		expect(markdown(classHover(p))).toContain(".primary-action {");
	});
});

describe("definition", () => {
	const { open } = setup("next-app");

	test("member access → every selector containing the class", () => {
		const defs = classDefinition(open("src/components/Button.tsx", cursorAt(button, "styles.button", 9)));
		expect(defs?.map(at)).toEqual([
			[toUri(BUTTON_CSS), 0, 1],
			[toUri(BUTTON_CSS), 6, 1],
			[toUri(BUTTON_CSS), 23, 2],
			[toUri(BUTTON_CSS), 28, 18],
		]);
		expect(defs?.[0]?.range.end).toEqual({ line: 0, character: 7 });
	});

	test("bracket access and nested selectors", () => {
		const kebab = classDefinition(open("src/components/Button.tsx", cursorAt(button, '"primary-action"', 3)));
		expect(kebab?.map(at)).toEqual([[toUri(BUTTON_CSS), 10, 1]]);
		const icon = classDefinition(open("src/components/Button.tsx", cursorAt(button, "styles.icon", 8)));
		expect(icon?.map(at)).toEqual([[toUri(BUTTON_CSS), 17, 2]]);
	});

	test("alias import", () => {
		const defs = classDefinition(open("src/components/Button.tsx", cursorAt(button, "base.reset", 6)));
		expect(defs?.map(at)).toEqual([[toUri(BASE_CSS), 0, 1]]);
	});

	test("import specifier → module file", () => {
		const defs = classDefinition(
			open("src/components/Button.tsx", cursorAt(button, "./Button.module.css", 4)),
		);
		expect(defs?.map(at)).toEqual([[toUri(BUTTON_CSS), 0, 0]]);
		const alias = classDefinition(open("src/components/Button.tsx", cursorAt(button, "@/styles", 2)));
		expect(alias?.map(at)).toEqual([[toUri(BASE_CSS), 0, 0]]);
	});

	test("named, namespace and require bindings", () => {
		const cardCss = toUri(fixture("next-app", "src/components/Card.module.css"));
		const def = (needle: string, delta: number, nth = 0) =>
			classDefinition(open("src/components/Card.tsx", cursorAt(card, needle, delta, nth)))?.map(at);
		expect(def("{ card }", 3)).toEqual([[cardCss, 0, 1]]);
		expect(def("${card}", 3)).toEqual([[cardCss, 0, 1]]);
		expect(def("ns.card", 4)).toEqual([[cardCss, 0, 1]]);
		expect(def("legacy.button", 8)?.[0]).toEqual([toUri(BUTTON_CSS), 0, 1]);
		expect(def("button: btn", 2)?.[0]).toEqual([toUri(BUTTON_CSS), 0, 1]);
		expect(def("${btn}", 3)?.[0]).toEqual([toUri(BUTTON_CSS), 0, 1]);
	});

	test("unknown, dynamic and non-module access → undefined", () => {
		expect(
			classDefinition(open("src/components/Button.tsx", cursorAt(button, "styles.missing", 8))),
		).toBeUndefined();
		expect(
			classDefinition(open("src/components/Button.tsx", cursorAt(button, "[variant]", 2))),
		).toBeUndefined();
		expect(
			classDefinition(open("src/components/Button.tsx", cursorAt(button, "variant }", 2))),
		).toBeUndefined();
	});

	test("monorepo: per-app alias and exported package", () => {
		const { open: mono } = setup("monorepo");
		const hero = read("monorepo", "apps/web/src/components/Hero.tsx");
		const heroCss = toUri(fixture("monorepo", "apps/web/src/components/Hero.module.css"));
		expect(
			classDefinition(mono("apps/web/src/components/Hero.tsx", cursorAt(hero, "styles.hero", 8)))?.map(at),
		).toEqual([[heroCss, 0, 1]]);
		const page = read("monorepo", "apps/docs/app/Page.tsx");
		const pageCss = toUri(fixture("monorepo", "apps/docs/app/Page.module.css"));
		expect(
			classDefinition(mono("apps/docs/app/Page.tsx", cursorAt(page, "styles.page", 8)))?.map(at),
		).toEqual([[pageCss, 0, 1]]);
		const ui = component('import ui from "@repo/ui/shared.module.css";', "ui.sur|face");
		const sharedCss = toUri(fixture("monorepo", "packages/ui/src/shared.module.css"));
		expect(classDefinition(mono("apps/web/src/components/X.tsx", ui))?.map(at)).toEqual([[sharedCss, 0, 1]]);
	});

	test("router respects definition.enabled", () => {
		const text = cursorAt(button, "styles.button", 9);
		expect(router.definition(setup("next-app").open("src/components/Button.tsx", text))).toHaveLength(4);
		const off = setup("next-app", { definition: { enabled: false } }).open("src/components/Button.tsx", text);
		expect(router.definition(off)).toBeUndefined();
	});
});

describe("hover", () => {
	const { open } = setup("next-app");
	const { open: tall } = setup("next-app", { hover: { enabled: true, maxLines: 100 } });

	test("all rules in source order with wrappers, then composed rules below a separator", () => {
		const p = tall("src/components/Button.tsx", cursorAt(button, "styles.button", 9));
		const h = classHover(p);
		const base = toUri(BASE_CSS);
		expect(markdown(h)).toBe(
			[
				"```css",
				".button {",
				'  composes: focusable from "@/styles/base.module.css";',
				"  color: var(--brand);",
				"  padding: var(--space-2);",
				"}",
				"",
				".button:hover {",
				"  color: var(--brand-alias);",
				"}",
				"",
				"@media (min-width: 40rem) {",
				"  .button {",
				"    padding: var(--space-1);",
				"  }",
				"}",
				"",
				":global(.legacy) .button {",
				"  opacity: 0.5;",
				"}",
				"",
				"/* ---- composed ---- */",
				"",
				".reset {",
				"  margin: 0;",
				"  padding: 0;",
				"}",
				"",
				".focusable {",
				"  composes: reset;",
				"  outline: none;",
				"}",
				"```",
				"",
				`Composed from [../styles/base.module.css](${base}#L1)`,
			].join("\n"),
		);
		const start = p.text.indexOf("styles.button") + 7;
		expect(h?.range).toEqual({ start: p.doc.positionAt(start), end: p.doc.positionAt(start + 6) });
	});

	test("nested rules; no composes footer when nothing is composed", () => {
		const h = classHover(open("src/components/Button.tsx", cursorAt(button, '"primary-action"', 3)));
		const value = markdown(h);
		expect(value).toContain(".primary-action:focus-visible {");
		expect(value).toContain(".primary-action .icon {");
		expect(value).not.toContain("composed");
	});

	test("recursive composes across files lists each source file once", () => {
		const h = classHover(tall("src/components/Card.tsx", cursorAt(card, "ns.card", 4)));
		const value = markdown(h);
		expect(value).toContain(
			[
				".card {",
				'  composes: button from "./Button.module.css";',
				"  --bg: red;",
				"}",
				"",
				"/* ---- composed ---- */",
				"",
				".reset {",
			].join("\n"),
		);
		expect(value).toContain(".focusable {\n  composes: reset;");
		expect(value).toContain(":global(.legacy) .button {");
		expect(value.indexOf(".focusable {")).toBeLessThan(value.indexOf(".button {"));
		expect(value).toEndWith(
			`Composed from [../styles/base.module.css](${toUri(BASE_CSS)}#L1), [./Button.module.css](${toUri(BUTTON_CSS)}#L1)`,
		);
	});

	test("truncates after hover.maxLines with a link to the definition", () => {
		const { open: short } = setup("next-app", { hover: { enabled: true, maxLines: 4 } });
		const value = markdown(
			classHover(short("src/components/Button.tsx", cursorAt(button, "styles.button", 9))),
		);
		expect(value).toStartWith(
			[
				"```css",
				".button {",
				'  composes: focusable from "@/styles/base.module.css";',
				"  color: var(--brand);",
				"  padding: var(--space-2);",
				"…",
				"```",
			].join("\n"),
		);
		expect(value).toEndWith(`[Go to definition](${toUri(BUTTON_CSS)}#L1)`);
	});

	test("alias, require and monorepo package", () => {
		expect(
			markdown(classHover(open("src/components/Button.tsx", cursorAt(button, "base.reset", 6)))),
		).toContain(".reset {\n  margin: 0;");
		expect(markdown(classHover(open("src/components/Card.tsx", cursorAt(card, "${btn}", 3))))).toContain(
			".button {",
		);
		const ui = component('import ui from "@repo/ui/shared.module.css";', "ui.sur|face");
		const value = markdown(classHover(setup("monorepo").open("apps/web/src/components/X.tsx", ui)));
		expect(value).toBe("```css\n.surface {\n  border-radius: 8px;\n}\n```");
	});

	test("unknown class → undefined", () => {
		expect(
			classHover(open("src/components/Button.tsx", cursorAt(button, "styles.missing", 8))),
		).toBeUndefined();
	});

	test("router respects hover.enabled", () => {
		const text = cursorAt(button, "styles.button", 9);
		expect(router.hover(setup("next-app").open("src/components/Button.tsx", text))).toBeDefined();
		const off = setup("next-app", { hover: { enabled: false, maxLines: 30 } }).open(
			"src/components/Button.tsx",
			text,
		);
		expect(router.hover(off)).toBeUndefined();
	});
});
