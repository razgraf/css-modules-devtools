import { describe, expect, test } from "bun:test";
import { type Loc, parseCss } from "@css-modules-devtools/core";
import { cssBlock, fileLink, firstDef } from "../src/markdown";

const loc = (file: string, line: number): Loc => ({
	file,
	start: { line, character: 0, offset: 0 },
	end: { line, character: 1, offset: 1 },
});

describe("cssBlock", () => {
	test("fences the lines", () => {
		expect(cssBlock([".a {", "}"], 5)).toEqual({ value: "```css\n.a {\n}\n```", truncated: false });
	});

	test("cuts after maxLines with an ellipsis", () => {
		expect(cssBlock(["1", "2", "3"], 2)).toEqual({ value: "```css\n1\n2\n…\n```", truncated: true });
		expect(cssBlock(["1", "2"], 2).truncated).toBe(false);
	});

	test("0 means no limit", () => {
		expect(cssBlock(["1", "2", "3"], 0)).toEqual({ value: "```css\n1\n2\n3\n```", truncated: false });
	});
});

describe("fileLink", () => {
	test("links to the 1-based line", () => {
		expect(fileLink("Go to definition", loc("/x/a b.module.css", 4))).toBe(
			"[Go to definition](file:///x/a%20b.module.css#L5)",
		);
	});
});

describe("firstDef", () => {
	test("prefers local classes, then globals", () => {
		const info = parseCss("/x/a.module.css", ".a {}\n:global(.a) {}\n:global(.g) {}\n");
		expect(firstDef(info, "a")?.loc.start.line).toBe(0);
		expect(firstDef(info, "g")?.loc.start.line).toBe(2);
	});

	test("undefined when missing", () => {
		expect(firstDef(parseCss("/x/a.module.css", ".a {}\n"), "b")).toBeUndefined();
		expect(firstDef(undefined, "a")).toBeUndefined();
	});
});
