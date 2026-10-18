import { describe, expect, test } from "bun:test";
import { cssContext, scriptContext, scriptState, stringRanges } from "../src";

/** `|` marks the cursor. */
const at = (fn: typeof scriptContext | typeof cssContext, marked: string) => {
	const offset = marked.indexOf("|");
	return fn(marked.replace("|", ""), offset);
};

describe("scriptContext", () => {
	test.each([
		["styles.|", { kind: "member", object: "styles", prefix: "" }],
		["<div className={styles.but|} />", { kind: "member", object: "styles", prefix: "but" }],
		["styles?.b|", { kind: "member", object: "styles", prefix: "b" }],
		['styles["pri|', { kind: "bracket", object: "styles", prefix: "pri", quote: '"' }],
		["styles['|']", { kind: "bracket", object: "styles", prefix: "", quote: "'" }],
		['style={{ color: "var(--br|" }}', { kind: "var", prefix: "--br" }],
		["`calc(var(|`", { kind: "var", prefix: "" }],
		["className={`${styles.but|}`}", { kind: "member", object: "styles", prefix: "but" }],
		["className={`a ${x} ${styles.|}`}", { kind: "member", object: "styles", prefix: "" }],
		["`${fn({ a: 1 })} ${styles.i|}`", { kind: "member", object: "styles", prefix: "i" }],
		["`${`${styles.|}`}`", { kind: "member", object: "styles", prefix: "" }],
		["`${a} var(--x|", { kind: "var", prefix: "--x" }],
		["`${'}'} var(--|", { kind: "var", prefix: "--" }],
		['import { a, b| } from "./x.module.css";', { kind: "named", specifier: "./x.module.css", prefix: "b" }],
	])("%s", (marked, expected) => {
		expect(at(scriptContext, marked)).toMatchObject(expected);
	});

	test.each([
		'"styles.|"',
		"`${a} styles.|`",
		"'\\'' + `x ${y}` + 'styles.|'",
		"var(--x|)",
		"import { a| } from 'react'".replace("from", ""),
	])("none for %s", (marked) => {
		expect(at(scriptContext, marked)?.kind).not.toBe("member");
	});

	test.each([
		["<p>Don't</p> <div className={styles.|}", { kind: "member", object: "styles", prefix: "" }],
		[
			'<div><p>A 5" screen</p><b className={styles.i|} /></div>',
			{ kind: "member", object: "styles", prefix: "i" },
		],
		[
			"return (\n\t<p>\n\t\tDon't click <a className={styles.|}",
			{ kind: "member", object: "styles", prefix: "" },
		],
		["<p>It's <span title=\"var(--x|", { kind: "var", prefix: "--x" }],
		["<p>It's</p>; const s = \"var(--|", { kind: "var", prefix: "--" }],
		["const re = /'/; const x = styles.|", { kind: "member", object: "styles", prefix: "" }],
		['s.replace(/"/g, "") + styles.a|', { kind: "member", object: "styles", prefix: "a" }],
		["/[/']/.test(x) && styles.|", { kind: "member", object: "styles", prefix: "" }],
		["a / b + c / 'var(--|", { kind: "var", prefix: "--" }],
		["/* don't */ styles.|", { kind: "member", object: "styles", prefix: "" }],
		["const a = 'oops\nconst x = styles.|", { kind: "member", object: "styles", prefix: "" }],
		['const f = <T,>(x: T) => "var(--|', { kind: "var", prefix: "--" }],
		['type F = <T>(x: T) => T; const s = "var(--|', { kind: "var", prefix: "--" }],
		["const x = `\n\tcolor: var(--|", { kind: "var", prefix: "--" }],
	])("JSX text, regexes and comments don't open strings: %s", (marked, expected) => {
		expect(at(scriptContext, marked)).toMatchObject(expected);
	});

	test.each([
		"<p>Don't</p><div title=\"styles.|",
		"<p>Don't</p>; const s = `${a} styles.|",
		"const re = /'/; const s = 'styles.|",
	])("still none inside strings after JSX text or regexes: %s", (marked) => {
		expect(at(scriptContext, marked)?.kind).not.toBe("member");
	});

	test("scans a bounded window that starts on a line", () => {
		const prefix = "const a = 'x';\n".repeat(2000);
		expect(at(scriptContext, `${prefix}const s = "var(--|`)).toMatchObject({ kind: "var", prefix: "--" });
		expect(at(scriptContext, `${prefix}const x = styles.|`)).toMatchObject({ kind: "member" });
	});
});

describe("stringRanges", () => {
	const contents = (text: string) => stringRanges(text).map((r) => text.slice(r.start, r.end));

	test("quotes, JSX attributes and template chunks; not JSX text, comments or regexes", () => {
		const text = [
			"const a = 'x\\'y';",
			'<p title="t" data-x=\'u\'>Don\'t "say" {`a${b + "c"}d`}</p>;',
			"// 'comment'",
			'/* "block" */',
			"const r = /'re'/g;",
			"const n = a / 2 / 'z';",
		].join("\n");
		expect(contents(text)).toEqual(["x\\'y", "t", "u", "a", "c", "d", "z"]);
	});

	test("unterminated literals end at the line break or the text end", () => {
		expect(contents('const a = \'open\nconst b = "ok";')).toEqual(["open", "ok"]);
		expect(contents("const t = `a ${x} b")).toEqual(["a ", " b"]);
	});

	test("type parameter lists are not JSX", () => {
		expect(contents("const f = <T,>(x: T) => 'a';\ntype G = <T>(x: T) => T;\nconst s = 'b';")).toEqual([
			"a",
			"b",
		]);
	});
});

describe("cssContext", () => {
	test.each([
		[".a { color: var(--b|", { kind: "var", prefix: "--b" }],
		[".a { composes: b|", { kind: "composesName", prefix: "b", specifier: null }],
		[
			'.a { composes: x |from "./y.module.css"; }',
			{ kind: "composesName", prefix: "", specifier: "./y.module.css" },
		],
		[".a { composes: |from global; }", { kind: "composesName", specifier: "global" }],
		['.a { composes: x from "@/sty|', { kind: "composesPath", prefix: "@/sty" }],
	])("%s", (marked, expected) => {
		expect(at(cssContext, marked)).toMatchObject(expected);
	});

	test("none outside composes/var", () => {
		expect(at(cssContext, ".a { color: re|")).toBeUndefined();
	});
});

describe("scanner regressions", () => {
	test("JSX type arguments don't desync the rest of the file", () => {
		const text = '<Table<Row> rows={rows} />;\nconst a = "x";\n<div className={styles.|} />';
		expect(at(scriptContext, text)).toMatchObject({ kind: "member", object: "styles" });
		expect(at(scriptContext, "<List<() => void> items={x} />;\nstyles.|")).toMatchObject({ kind: "member" });
	});

	test.each(["// styles.|", "/* styles.| */", "const r = /styles.|/"])("no completion in %s", (marked) => {
		expect(at(scriptContext, marked)).toBeUndefined();
	});

	test("scriptState reports comments but not URLs in JSX text", () => {
		const text = "<a>see https://x.dev</a>; styles.";
		expect(scriptState(text, text.length)).toBe("code");
		expect(scriptState("// styles.", 10)).toBe("comment");
	});
});
