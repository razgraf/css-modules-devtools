import type { AtRule, Container, Node as CssNode, Declaration, Rule } from "postcss";
import safeParse from "postcss-safe-parser";
import selectorParser from "postcss-selector-parser";
import { LineIndex } from "../text";
import type {
	ClassDef,
	Composes,
	CssInfo,
	Decl,
	ImportRef,
	NameRef,
	RuleInfo,
	VarDecl,
	VarUse,
} from "../types";

type Mode = "local" | "global";

interface SelectorClass {
	name: string;
	index: number;
	mode: Mode;
}

interface SelectorInfo {
	classes: SelectorClass[];
	parts: SelectorPart[];
}

interface SelectorPart {
	text: string;
	/** Offsets of `&` within `text`. */
	nesting: number[];
	/** `&-suffix` / `&_suffix` / `&Suffix`: Sass-style concatenation, not valid native nesting. */
	concat: boolean;
}

const VAR_HEAD_RE = /var\(\s*(--[\w-]+)\s*/y;
const COMMENT_RE = /\/\*[\s\S]*?(?:\*\/|$)/g;
const IMPORT_RE = /^(?:url\(\s*)?(['"]?)([^'")\s]+)\1/;

export function parseCss(file: string, text: string): CssInfo {
	const index = new LineIndex(text);
	const info: CssInfo = {
		file,
		classes: new Map(),
		globals: new Map(),
		rules: [],
		composes: [],
		varDecls: [],
		varUses: [],
		imports: [],
	};

	let root: Container;
	try {
		root = safeParse(text);
	} catch {
		return info;
	}

	const startOf = (node: CssNode) => node.source?.start?.offset ?? 0;
	const endOf = (node: CssNode) => node.source?.end?.offset ?? text.length;

	// Top-level selector count of each rule, so nested rules needn't re-parse the parent's resolved selector.
	const partCounts = new WeakMap<RuleInfo, number>();

	const visit = (container: Container, parent: RuleInfo | undefined, wrappers: string[], depth: number) => {
		for (const node of container.nodes ?? []) {
			if (node.type === "rule") {
				visitRule(node, parent, wrappers, depth);
			} else if (node.type === "atrule") {
				visitAtRule(node, parent, wrappers, depth);
			} else if (node.type === "decl" && parent) {
				visitDecl(node, parent);
			}
		}
	};

	const visitAtRule = (node: AtRule, parent: RuleInfo | undefined, wrappers: string[], depth: number) => {
		const name = node.name.toLowerCase();
		if (name === "import") {
			const offset = startOf(node) + 1 + node.name.length + (node.raws.afterName?.length ?? 0);
			const match = IMPORT_RE.exec(node.params);
			if (match?.[2]) {
				const start = offset + match[0].indexOf(match[2]);
				info.imports.push({ specifier: match[2], loc: index.loc(file, start, start + match[2].length) });
			}
			return;
		}
		if (name.endsWith("keyframes")) return;
		if (name === "property") {
			const prop = node.params.trim();
			if (prop.startsWith("--")) {
				const initial = node.nodes?.find(
					(n): n is Declaration => n.type === "decl" && n.prop === "initial-value",
				);
				const start = startOf(node) + 1 + node.name.length + (node.raws.afterName?.length ?? 0);
				info.varDecls.push({
					name: prop,
					value: initial?.value ?? "",
					depth: 0,
					selector: `@property ${prop}`,
					loc: index.loc(file, start, start + prop.length),
				});
			}
			return;
		}
		const inner = [...wrappers, `@${node.name} ${node.params}`.trim()];
		// Declarations directly inside an at-rule nested in a rule apply to the parent's selector under
		// the extra wrapper, so they get their own rule rather than being merged into the parent.
		const scoped =
			parent && node.nodes?.some((n) => n.type === "decl")
				? {
						...parent,
						wrappers: inner,
						declarations: [],
						loc: index.loc(file, startOf(node), endOf(node)),
					}
				: parent;
		if (scoped && parent && scoped !== parent) {
			info.rules.push(scoped);
			partCounts.set(scoped, partCounts.get(parent) ?? 1);
		}
		visit(node, scoped, inner, depth);
	};

	const visitRule = (node: Rule, parent: RuleInfo | undefined, wrappers: string[], depth: number) => {
		const raw = node.raws.selector?.raw ?? node.selector;
		const { classes: own, parts } = analyzeSelector(raw);
		const nested = parent ? resolveNesting(parts, parent.selector, partCounts.get(parent) ?? 1) : undefined;
		const inherited = nested?.inherits && parent ? parent.classes : [];
		const rule: RuleInfo = {
			selector: nested?.selector ?? raw,
			wrappers,
			declarations: [],
			classes: new Set([...inherited, ...own.map((c) => c.name)]),
			depth,
			loc: index.loc(file, startOf(node), endOf(node)),
		};
		info.rules.push(rule);
		partCounts.set(rule, parts.length);

		const base = startOf(node);
		for (const cls of own) {
			const start = base + cls.index + 1;
			const def: ClassDef = { name: cls.name, loc: index.loc(file, start, start + cls.name.length), rule };
			const target = cls.mode === "local" ? info.classes : info.globals;
			const list = target.get(cls.name);
			if (list) list.push(def);
			else target.set(cls.name, [def]);
		}

		const owners = [...new Set(own.filter((c) => c.mode === "local").map((c) => c.name))];
		for (const child of node.nodes ?? []) {
			if (child.type === "decl" && child.prop.toLowerCase() === "composes") {
				visitComposes(child, owners);
			}
		}
		visit(node, rule, wrappers, depth + 1);
	};

	const valueStart = (node: Declaration) =>
		startOf(node) + node.prop.length + (node.raws.between?.length ?? 0);

	// postcss strips comments from `node.value`; offsets must come from the source text.
	const rawValue = (node: Declaration) => {
		const raw = node.raws.value;
		return raw && raw.value === node.value ? raw.raw : node.value;
	};

	const visitDecl = (node: Declaration, rule: RuleInfo) => {
		const start = startOf(node);
		const vStart = valueStart(node);
		const raw = rawValue(node);
		const decl: Decl = {
			prop: node.prop,
			value: node.important ? `${node.value} !important` : node.value,
			loc: index.loc(file, start, vStart + raw.trimEnd().length),
		};
		rule.declarations.push(decl);

		if (node.prop.startsWith("--")) {
			const v: VarDecl = {
				name: node.prop,
				value: node.value.trim(),
				depth: rule.depth,
				selector: rule.selector,
				loc: index.loc(file, start, start + node.prop.length),
			};
			info.varDecls.push(v);
		}

		const masked = maskComments(raw);
		for (const m of masked.matchAll(/var\(/g)) {
			const expr = readVar(masked, m.index ?? 0);
			if (!expr) continue;
			const use: VarUse = {
				name: expr.name,
				fallback: masked === raw ? expr.fallback : rawFallback(raw, masked, expr),
				loc: index.loc(file, vStart + expr.nameStart, vStart + expr.nameStart + expr.name.length),
				expr: index.loc(file, vStart + expr.start, vStart + expr.end),
			};
			info.varUses.push(use);
		}
	};

	const visitComposes = (node: Declaration, owners: string[]) => {
		const vStart = valueStart(node);
		const raw = rawValue(node);
		const masked = maskComments(raw);
		const parts = splitComposes(masked);
		const names: NameRef[] = [];
		for (const m of masked.slice(0, parts.namesEnd).matchAll(/[^\s,]+/g)) {
			const s = vStart + (m.index ?? 0);
			names.push({ name: m[0], loc: index.loc(file, s, s + m[0].length) });
		}
		let from: Composes["from"] = null;
		if (parts.from === "global") {
			from = "global";
		} else if (parts.from) {
			const { start, end } = parts.from;
			from = { specifier: masked.slice(start, end), loc: index.loc(file, vStart + start, vStart + end) };
		}
		info.composes.push({
			names,
			from,
			owners,
			loc: index.loc(file, startOf(node), vStart + raw.trimEnd().length),
		});
	};

	visit(root, undefined, [], 0);
	return info;
}

export interface VarExpr {
	name: string;
	nameStart: number;
	/** Text between the comma and the closing paren (or `limit` while unclosed), trimmed. */
	fallback: string | undefined;
	start: number;
	/** After the closing paren, or after the name while unclosed. */
	end: number;
	closed: boolean;
}

/**
 * Reads the `var(` expression at `start`, balancing parentheses so fallbacks such as `rgb(0 0 0 / 50%)`
 * stay whole. `var()`s nested in the fallback are separate expressions; callers find them by scanning on.
 */
export function readVar(text: string, start: number, limit = text.length): VarExpr | undefined {
	VAR_HEAD_RE.lastIndex = start;
	const head = VAR_HEAD_RE.exec(text);
	if (!head?.[1] || start + head[0].length > limit) return undefined;
	const name = head[1];
	const nameStart = start + head[0].indexOf(name);
	const nameEnd = nameStart + name.length;
	const next = start + head[0].length;
	const open = { name, nameStart, start, end: nameEnd, closed: false };
	if (text[next] === ")") return { ...open, fallback: undefined, end: next + 1, closed: true };
	if (text[next] !== ",") return { ...open, fallback: undefined };
	let depth = 1;
	for (let i = next + 1; i < limit; i++) {
		const ch = text[i];
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) {
			return { ...open, fallback: text.slice(next + 1, i).trim() || undefined, end: i + 1, closed: true };
		}
	}
	return { ...open, fallback: text.slice(next + 1, limit).trim() || undefined };
}

interface ComposesParts {
	/** End of the class names, before any `from` clause and trailing `;`. */
	namesEnd: number;
	/** `start`/`end` of the specifier between its quotes. */
	from: { start: number; end: number } | "global" | null;
}

const SPACE_RE = /\s/;
const isSpace = (ch: string | undefined) => ch !== undefined && SPACE_RE.test(ch);

const skipSpaceBack = (text: string, end: number) => {
	let i = end;
	while (i > 0 && isSpace(text[i - 1])) i--;
	return i;
};

/** Splits `names [from "spec" | from global][;]` by scanning back from the end, in linear time. */
function splitComposes(value: string): ComposesParts {
	let end = skipSpaceBack(value, value.length);
	if (value[end - 1] === ";") end = skipSpaceBack(value, end - 1);
	const none: ComposesParts = { namesEnd: end, from: null };

	let from: ComposesParts["from"];
	let clauseStart: number;
	const last = value[end - 1];
	if (last === '"' || last === "'") {
		const open = end >= 2 ? value.lastIndexOf(last, end - 2) : -1;
		if (open < 0) return none;
		from = { start: open + 1, end: end - 1 };
		clauseStart = open;
	} else if (value.endsWith("global", end)) {
		from = "global";
		clauseStart = end - "global".length;
	} else {
		return none;
	}

	const keywordEnd = skipSpaceBack(value, clauseStart);
	const keywordStart = keywordEnd - "from".length;
	if (keywordEnd === clauseStart || !value.endsWith("from", keywordEnd)) return none;
	const namesEnd = skipSpaceBack(value, keywordStart);
	if (namesEnd === keywordStart) return none;
	return { namesEnd, from };
}

/** Blanks out comments (keeping offsets) so callers can scan values as written in the source. */
function maskComments(text: string): string {
	if (!text.includes("/*")) return text;
	let out = "";
	let last = 0;
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			const stop = close < 0 ? text.length : close + 2;
			out += text.slice(last, i) + " ".repeat(stop - i);
			last = stop;
			i = stop - 1;
		}
	}
	return out + text.slice(last);
}

/** The fallback of `expr` (read from `masked`) as written in `raw`, minus comments. */
function rawFallback(raw: string, masked: string, expr: VarExpr): string | undefined {
	if (expr.fallback === undefined) return undefined;
	const start = masked.indexOf(",", expr.nameStart + expr.name.length) + 1;
	const end = expr.closed ? expr.end - 1 : raw.length;
	return raw.slice(start, end).replace(COMMENT_RE, "").trim() || undefined;
}

const SIMPLE_IDENT = "-?[_a-zA-Z][\\w-]*";
const SIMPLE_COMPOUND = `(?:[a-zA-Z][\\w-]*(?:\\.${SIMPLE_IDENT})*|(?:\\.${SIMPLE_IDENT})+)`;
/** Class/tag compounds joined by combinators: no lists, `&`, pseudos, attributes, escapes or comments. */
const SIMPLE_SELECTOR_RE = new RegExp(
	`^\\s*${SIMPLE_COMPOUND}(?:\\s*[>+~]\\s*${SIMPLE_COMPOUND}|\\s+${SIMPLE_COMPOUND})*\\s*$`,
);
const SIMPLE_CLASS_RE = new RegExp(`\\.(${SIMPLE_IDENT})`, "g");

/** Classes and top-level parts of a selector from one parse; simple selectors skip the parser. */
function analyzeSelector(selector: string): SelectorInfo {
	if (SIMPLE_SELECTOR_RE.test(selector)) {
		const classes = [...selector.matchAll(SIMPLE_CLASS_RE)].map(
			(m): SelectorClass => ({ name: m[1] ?? "", index: m.index ?? 0, mode: "local" }),
		);
		return { classes, parts: [{ text: selector, nesting: [], concat: false }] };
	}

	const classes: SelectorClass[] = [];
	const parts: SelectorPart[] = [];
	const walk = (nodes: selectorParser.Node[], initial: Mode) => {
		let mode = initial;
		for (const node of nodes) {
			if (node.type === "selector") {
				walk(node.nodes, initial);
			} else if (node.type === "pseudo") {
				const name = node.value.toLowerCase();
				if (name === ":global" || name === ":local") {
					const next: Mode = name === ":global" ? "global" : "local";
					if (node.nodes.length > 0) walk(node.nodes, next);
					else mode = next;
				} else {
					walk(node.nodes, mode);
				}
			} else if (node.type === "class") {
				classes.push({ name: node.value, index: node.sourceIndex, mode });
			}
		}
	};
	try {
		selectorParser((root) => {
			walk(root.nodes, "local");
			for (const sel of root.nodes) {
				const nesting: number[] = [];
				let concat = false;
				sel.walkNesting((n) => {
					nesting.push(n.sourceIndex - sel.sourceIndex);
					if (n.next()?.type === "tag") concat = true;
				});
				parts.push({ text: sel.toString(), nesting: nesting.sort((a, b) => a - b), concat });
			}
		}).processSync(selector, { lossless: true });
	} catch {
		// Half-typed selectors are expected while editing.
		const nesting = [...selector.matchAll(/&/g)].map((m) => m.index ?? 0);
		return { classes, parts: [{ text: selector, nesting, concat: false }] };
	}
	return { classes, parts };
}

/**
 * Resolves `&` against the parent selector. `inherits` is false when every part concatenates onto `&`
 * (`&-icon`): such rules target a different class, so they must not be attributed to the parent's.
 */
function resolveNesting(
	parts: SelectorPart[],
	parent: string,
	parentParts: number,
): { selector: string; inherits: boolean } {
	const parentRef = parentParts > 1 ? `:is(${parent})` : parent;
	const resolved = parts.map(({ text, nesting }) => {
		if (nesting.length === 0) return `${parentRef} ${text.trim()}`;
		let out = "";
		let last = 0;
		for (const at of nesting) {
			out += text.slice(last, at) + parentRef;
			last = at + 1;
		}
		return (out + text.slice(last)).trim();
	});
	return { selector: resolved.join(", "), inherits: parts.some((p) => !p.concat) };
}

export function formatRule(rule: RuleInfo, decls: string[] = rule.declarations.map(formatDecl)): string {
	const indent = (level: number) => "  ".repeat(level);
	const lines: string[] = [];
	rule.wrappers.forEach((w, i) => {
		lines.push(`${indent(i)}${w} {`);
	});
	const level = rule.wrappers.length;
	lines.push(`${indent(level)}${rule.selector} {`);
	for (const d of decls) lines.push(`${indent(level + 1)}${d}`);
	lines.push(`${indent(level)}}`);
	for (let i = rule.wrappers.length - 1; i >= 0; i--) lines.push(`${indent(i)}}`);
	return lines.join("\n");
}

export function formatDecl(decl: Decl): string {
	return `${decl.prop}: ${decl.value};`;
}

export type { ImportRef };
