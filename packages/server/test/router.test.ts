import { describe, expect, test } from "bun:test";
import {
	type CompletionItem,
	type Hover,
	type Location,
	LocationLink,
	MarkupContent,
} from "vscode-languageserver";
import * as router from "../src/router";
import { cursorAt, fixture, read, setup } from "./helpers";

const NEXT = { globalFiles: ["src/app/globals.css"] };
const BUTTON_TSX = "src/components/Button.tsx";
const button = read("next-app", BUTTON_TSX);

const labels = (items: CompletionItem[]) => items.map((i) => i.label).sort();
const markdown = (h: Hover | undefined) => (h && MarkupContent.is(h.contents) ? h.contents.value : "");
const uriOf = (l: Location | LocationLink) => (LocationLink.is(l) ? l.targetUri : l.uri);

describe("script completion routing", () => {
	test("class completion inside a template literal substitution", () => {
		const { open } = setup("next-app");
		const items = router.completion(
			open(BUTTON_TSX, cursorAt(button, "${styles.button}", "${styles.".length)),
		);
		expect(labels(items)).toEqual(["button", "icon", "primary-action"]);
	});

	test("var completion in a string on the same line as a class access", () => {
		const { open } = setup("next-app", NEXT);
		const items = router.completion(
			open(BUTTON_TSX, cursorAt(button, '"var(--brand)"', "var(--br".length + 1)),
		);
		expect(labels(items)).toEqual(["--brand", "--brand-alias"]);
	});

	test("bound CSS module → classes, unbound → auto-import, other bindings → nothing", () => {
		const { open } = setup("next-app");
		const bound = router.completion(open(BUTTON_TSX, cursorAt(button, "styles.icon", "styles.".length)));
		expect(bound.every((i) => !i.additionalTextEdits)).toBe(true);

		const unbound = router.completion(open("src/components/New.tsx", "export const x = styles.|;\n"));
		expect(unbound.length).toBeGreaterThan(0);
		expect(unbound.every((i) => i.additionalTextEdits?.length === 1)).toBe(true);

		const other = router.completion(open("src/components/New.tsx", "const styles = { a: 1 };\nstyles.|\n"));
		expect(other).toEqual([]);
	});
});

describe("completion resolve", () => {
	test("class items defer documentation to resolveCompletion", () => {
		const { ctx, open } = setup("next-app");
		const items = router.completion(open(BUTTON_TSX, cursorAt(button, "styles.icon", "styles.".length)));
		expect(items.every((i) => i.documentation === undefined)).toBe(true);
		const icon = items.find((i) => i.label === "icon");
		if (!icon) throw new Error("no icon item");
		const doc = router.resolveCompletion(ctx, icon).documentation;
		expect(MarkupContent.is(doc) ? doc.value : "").toBe(
			"```css\n.primary-action .icon {\n  width: 1rem;\n}\n```",
		);
	});

	test("items without class data are returned unchanged", () => {
		const { ctx } = setup("next-app");
		for (const data of [undefined, null, "class", { kind: "class", file: 1, name: "x" }]) {
			const item: CompletionItem = { label: "x", data };
			expect(router.resolveCompletion(ctx, item)).toBe(item);
		}
	});
});

describe("hover and definition precedence in scripts", () => {
	test("class usage → class hover; var() string → var hover", () => {
		const { open } = setup("next-app", NEXT);
		const cls = markdown(router.hover(open(BUTTON_TSX, cursorAt(button, "styles.button", 8))));
		expect(cls).toContain(".button {");
		const v = markdown(router.hover(open(BUTTON_TSX, cursorAt(button, "--brand)", 3))));
		expect(v).toContain("`--brand: oklch(62% 0.2 255)`");
		expect(v).not.toContain(".button {");
	});

	test("var definition when the cursor is not on a class usage", () => {
		const { open } = setup("next-app", NEXT);
		const locs = router.definition(open(BUTTON_TSX, cursorAt(button, "--brand)", 3)));
		expect(locs?.map((l) => uriOf(l).split("/fixtures/")[1])).toContain("next-app/src/app/colors.css");
	});

	test("definition.enabled and hover.enabled also switch off var() lookups", () => {
		const off = { ...NEXT, definition: { enabled: false }, hover: { enabled: false, maxLines: 30 } };
		const p = setup("next-app", off).open(BUTTON_TSX, cursorAt(button, "--brand)", 3));
		expect(router.definition(p)).toBeUndefined();
		expect(router.hover(p)).toBeUndefined();
		const css = "src/components/Button.module.css";
		const q = setup("next-app", off).open(css, cursorAt(read("next-app", css), "--space-2", 3));
		expect(router.definition(q)).toBeUndefined();
	});
});

describe("mid-edit text", () => {
	const broken = button.replace("<span className={styles.icon} />", "<span className={styles.} />");

	test("definition and hover use the last good parse; diagnostics wait for a parse", () => {
		const { open } = setup("next-app");
		expect(router.diagnostics(open(BUTTON_TSX)).map((d) => d.code)).toEqual(["missingClass"]);

		const p = open(BUTTON_TSX, cursorAt(broken, "styles.button", 8));
		const def = router.definition(p)?.[0];
		expect(def && uriOf(def)).toBe(`file://${fixture("next-app", "src/components/Button.module.css")}`);
		expect(markdown(router.hover(p))).toContain(".button {");
		expect(router.diagnostics(p)).toEqual([]);

		const completion = router.completion(open(BUTTON_TSX, cursorAt(broken, "styles.}", "styles.".length)));
		expect(labels(completion)).toEqual(["button", "icon", "primary-action"]);
	});
});

describe("stylesheet routing", () => {
	test("composes name → class hover; var() → var hover", () => {
		const { open } = setup("next-app", NEXT);
		const css = read("next-app", "src/components/Button.module.css");
		const file = "src/components/Button.module.css";
		expect(markdown(router.hover(open(file, cursorAt(css, "focusable", 2))))).toContain("**.focusable**");
		expect(markdown(router.hover(open(file, cursorAt(css, "--space-2", 3))))).toContain("--space-2");
	});
});
