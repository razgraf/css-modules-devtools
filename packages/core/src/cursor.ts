/**
 * Text-based completion contexts. The AST is unreliable while typing (`styles.` alone doesn't parse),
 * so completion looks at the raw text around the cursor and pairs it with the last good analysis.
 */

export type ScriptContext =
	| { kind: "member"; object: string; prefix: string; start: number }
	| { kind: "bracket"; object: string; prefix: string; quote: string; start: number }
	| { kind: "named"; specifier: string; prefix: string; start: number }
	| { kind: "var"; prefix: string; start: number };

export type CssContext =
	| { kind: "var"; prefix: string; start: number }
	| { kind: "composesName"; specifier: string | "global" | null; prefix: string; start: number }
	| { kind: "composesPath"; prefix: string; start: number };

const MEMBER_RE = /([A-Za-z_$][\w$]*)\s*\??\.\s*([\w$]*)$/;
const BRACKET_RE = /([A-Za-z_$][\w$]*)\s*(?:\?\.)?\[\s*(['"`])([^'"`\]]*)$/;
const VAR_RE = /var\(\s*(-{0,2}[\w-]*)$/;
const NAMED_BEFORE_RE = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)$/;
const NAMED_AFTER_RE = /^[^}]*\}\s*from\s*(['"])([^'"]+)\1/;
const LINE_START_RE = /[^\n]*$/;

/** Bound on how much text before the cursor is tokenized to find out whether it sits in a string. */
const MAX_SCAN = 20_000;

export function scriptContext(text: string, offset: number): ScriptContext | undefined {
	const before = text.slice(Math.max(0, offset - 500), offset);
	const line = LINE_START_RE.exec(before)?.[0] ?? "";

	const state = scriptState(text, offset);
	if (state === "comment" || state === "regex") return undefined;
	const inString = state === "string";
	const v = VAR_RE.exec(line);
	if (v && inString) return { kind: "var", prefix: v[1] ?? "", start: offset - (v[1]?.length ?? 0) };

	const b = BRACKET_RE.exec(line);
	if (b?.[1] && b[2])
		return {
			kind: "bracket",
			object: b[1],
			quote: b[2],
			prefix: b[3] ?? "",
			start: offset - (b[3]?.length ?? 0),
		};

	const named = NAMED_BEFORE_RE.exec(before);
	if (named) {
		const after = NAMED_AFTER_RE.exec(text.slice(offset, offset + 500));
		if (after?.[2]) {
			const prefix = /[\w$]*$/.exec(named[1] ?? "")?.[0] ?? "";
			return { kind: "named", specifier: after[2], prefix, start: offset - prefix.length };
		}
	}

	if (inString) return undefined;
	const m = MEMBER_RE.exec(line);
	if (m?.[1])
		return { kind: "member", object: m[1], prefix: m[2] ?? "", start: offset - (m[2]?.length ?? 0) };
	return undefined;
}

/** The contents of string literals, JSX attribute strings and template literal chunks in a script. */
export interface StringRange {
	start: number;
	end: number;
}

/**
 * String contents of a script, without quotes. Template substitutions are code and split a template into
 * chunks; JSX text, comments and regex literals are not strings. Unterminated quotes end at the line break.
 */
export function stringRanges(text: string): StringRange[] {
	const ranges: StringRange[] = [];
	scanScript(text, 0, text.length, (start, end) => {
		ranges.push({ start, end });
	});
	return ranges;
}

/** What the cursor at `offset` sits in, from a bounded scan of the text before it. */
export function scriptState(text: string, offset: number): ScanState {
	return scanScript(text, scanStart(text, offset), offset);
}

function scanStart(text: string, offset: number): number {
	if (offset <= MAX_SCAN) return 0;
	const cut = text.indexOf("\n", offset - MAX_SCAN);
	return cut === -1 || cut >= offset ? offset - MAX_SCAN : cut + 1;
}

export type ScanState = "code" | "string" | "comment" | "regex" | "jsx";

type Frame =
	| { kind: "code"; braces: number }
	| { kind: "template" }
	| { kind: "tag"; closing: boolean }
	| { kind: "children" };

const IDENT_START_RE = /[A-Za-z_$]/;
const IDENT_RE = /[\w$]/;
const NUMBER_RE = /[\w.]/;
const SPACE_RE = /\s/;
/** `<` at an expression start that opens a TypeScript type parameter list rather than a JSX element. */
const GENERIC_RE = /<\s*(?:const\s+)?[A-Za-z_$][\w$]*\s*(?:,|=|extends\s|>\s*\()/y;
/** Keywords after which `/` starts a regex and `<` starts a JSX element. */
const EXPR_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
	"default",
]);

/**
 * A small JS/TS/JSX tokenizer over `text[from, to)` that reports what the end of that range sits in and
 * emits string contents. It is a heuristic, not a parser: the AST is unavailable while typing, and a
 * line-based quote count is fooled by apostrophes in JSX text and quotes in regex literals.
 */
function scanScript(
	text: string,
	from: number,
	to: number,
	emit?: (start: number, end: number) => void,
): ScanState {
	const frames: Frame[] = [{ kind: "code", braces: 0 }];
	// Whether the next token starts an expression, where `/` opens a regex and `<` a JSX element.
	let exprStart = true;
	let chunk = from;
	let i = from;

	const leaveElement = () => {
		if (frames[frames.length - 1]?.kind === "code") exprStart = false;
	};

	while (i < to) {
		const top = frames[frames.length - 1];
		if (!top) break;
		const ch = text[i] ?? "";

		if (top.kind === "template") {
			if (ch === "\\") i += 2;
			else if (ch === "`") {
				emit?.(chunk, i);
				frames.pop();
				exprStart = false;
				i++;
			} else if (ch === "$" && text[i + 1] === "{") {
				emit?.(chunk, i);
				frames.push({ kind: "code", braces: 0 });
				exprStart = true;
				i += 2;
			} else i++;
			continue;
		}

		if (top.kind === "tag") {
			if (ch === "<" && !top.closing) {
				// TypeScript type arguments on the element, e.g. `<Table<Row> rows={…} />`.
				i = angleEnd(text, i, to);
			} else if (ch === '"' || ch === "'") {
				const end = text.indexOf(ch, i + 1);
				if (end === -1 || end >= to) {
					emit?.(i + 1, to);
					return "string";
				}
				emit?.(i + 1, end);
				i = end + 1;
			} else if (ch === "{") {
				frames.push({ kind: "code", braces: 0 });
				exprStart = true;
				i++;
			} else if (ch === "/" && text[i + 1] === ">") {
				frames.pop();
				leaveElement();
				i += 2;
			} else if (ch === ">") {
				frames.pop();
				if (!top.closing) frames.push({ kind: "children" });
				else if (frames[frames.length - 1]?.kind === "children") frames.pop();
				leaveElement();
				i++;
			} else i++;
			continue;
		}

		if (top.kind === "children") {
			if (ch === "{") {
				frames.push({ kind: "code", braces: 0 });
				exprStart = true;
				i++;
			} else if (ch === "<") {
				const closing = text[i + 1] === "/";
				frames.push({ kind: "tag", closing });
				i += closing ? 2 : 1;
			} else i++;
			continue;
		}

		if (SPACE_RE.test(ch)) {
			i++;
		} else if (ch === "/" && text[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			if (end === -1 || end >= to) return "comment";
			i = end;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end === -1 || end + 2 > to) return "comment";
			i = end + 2;
		} else if (ch === "/" && exprStart) {
			const end = regexEnd(text, i + 1, to);
			if (end === -1) return "regex";
			i = end;
			while (i < to && IDENT_RE.test(text[i] ?? "")) i++;
			exprStart = false;
		} else if ((ch === '"' || ch === "'") && !IDENT_RE.test(text[i - 1] ?? "")) {
			// A quote right after a word can't open a literal in valid code: it is prose such as `Don't`.
			const end = quoteEnd(text, i + 1, to, ch);
			emit?.(i + 1, end);
			if (end >= to) return "string";
			i = text[end] === ch ? end + 1 : end;
			exprStart = false;
		} else if (ch === "`") {
			frames.push({ kind: "template" });
			chunk = i + 1;
			i++;
		} else if (ch === "{") {
			top.braces++;
			exprStart = true;
			i++;
		} else if (ch === "}") {
			exprStart = true;
			i++;
			if (top.braces > 0) top.braces--;
			else if (frames.length > 1) {
				frames.pop();
				if (frames[frames.length - 1]?.kind === "template") chunk = i;
			}
		} else if (ch === "<" && exprStart && isJsxStart(text, i)) {
			frames.push({ kind: "tag", closing: false });
			i++;
		} else if (IDENT_START_RE.test(ch)) {
			const start = i;
			while (i < to && IDENT_RE.test(text[i] ?? "")) i++;
			exprStart = EXPR_KEYWORDS.has(text.slice(start, i));
		} else if (ch >= "0" && ch <= "9") {
			while (i < to && NUMBER_RE.test(text[i] ?? "")) i++;
			exprStart = false;
		} else {
			exprStart = ch !== ")" && ch !== "]";
			i++;
		}
	}

	const top = frames[frames.length - 1];
	if (top?.kind === "template") {
		emit?.(chunk, to);
		return "string";
	}
	return top?.kind === "tag" || top?.kind === "children" ? "jsx" : "code";
}

/** Index just past the `>` that balances the `<` at `i`, or `to`. */
function angleEnd(text: string, i: number, to: number): number {
	let depth = 0;
	for (; i < to; i++) {
		if (text[i] === "<") depth++;
		else if (text[i] === ">" && text[i - 1] !== "=" && --depth === 0) return i + 1;
	}
	return to;
}

/** Index of the closing quote, or of the line break / range end that cuts the literal short. */
function quoteEnd(text: string, i: number, to: number, quote: string): number {
	while (i < to) {
		const ch = text[i];
		if (ch === "\\") i += 2;
		else if (ch === quote || ch === "\n") return i;
		else i++;
	}
	return to;
}

/** Index just past the closing `/` of a regex body, or -1 when it runs to the range end. */
function regexEnd(text: string, i: number, to: number): number {
	let inClass = false;
	while (i < to) {
		const ch = text[i];
		if (ch === "\\") i += 2;
		else if (ch === "\n") return i;
		else {
			if (ch === "[") inClass = true;
			else if (ch === "]") inClass = false;
			else if (ch === "/" && !inClass) return i + 1;
			i++;
		}
	}
	return -1;
}

function isJsxStart(text: string, i: number): boolean {
	const next = text[i + 1] ?? "";
	if (next !== ">" && !IDENT_START_RE.test(next)) return false;
	GENERIC_RE.lastIndex = i;
	return !GENERIC_RE.test(text);
}

export function cssContext(text: string, offset: number): CssContext | undefined {
	const before = text.slice(Math.max(0, offset - 500), offset);

	const v = VAR_RE.exec(before);
	if (v) return { kind: "var", prefix: v[1] ?? "", start: offset - (v[1]?.length ?? 0) };

	const decl = /composes\s*:\s*([^;{}]*)$/i.exec(before);
	if (!decl) return undefined;
	const value = decl[1] ?? "";

	const path = /\bfrom\s+(['"])([^'"]*)$/.exec(value);
	if (path) return { kind: "composesPath", prefix: path[2] ?? "", start: offset - (path[2]?.length ?? 0) };
	if (/\bfrom\b/.test(value)) return undefined;

	const prefix = /[\w-]*$/.exec(value)?.[0] ?? "";
	const rest = /^[^;{}]*/.exec(text.slice(offset, offset + 500))?.[0] ?? "";
	const target = /\bfrom\s+(?:(['"])(.*?)\1|(global)\b)/.exec(rest);
	const specifier = target ? (target[3] ? "global" : (target[2] ?? null)) : null;
	return { kind: "composesName", specifier, prefix, start: offset - prefix.length };
}
