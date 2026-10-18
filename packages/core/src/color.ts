import {
	modeA98,
	modeHsl,
	modeHwb,
	modeLab,
	modeLch,
	modeLrgb,
	modeOklab,
	modeOklch,
	modeP3,
	modeProphoto,
	modeRec2020,
	modeRgb,
	modeXyz50,
	modeXyz65,
	parse,
	useMode,
} from "culori/fn";
import { readVar } from "./css/parse";
import type { VarDecl } from "./types";

export interface Rgba {
	red: number;
	green: number;
	blue: number;
	alpha: number;
}

// `culori/fn` registers nothing by itself; only CSS Color 4 syntaxes (incl. `color()` spaces) are bundled.
const toRgb = useMode(modeRgb);
const CSS_MODES = [
	modeHsl,
	modeHwb,
	modeLab,
	modeLch,
	modeOklab,
	modeOklch,
	modeLrgb,
	modeP3,
	modeRec2020,
	modeA98,
	modeProphoto,
	modeXyz50,
	modeXyz65,
];
for (const mode of CSS_MODES) useMode(mode);
const MAX_HOPS = 10;

const ROOT_SELECTOR_RE = /^(?::global\(\s*)?(?::root|html|:where\(\s*(?::root|html)\s*\)|:host)(?:\s*\))?$/i;

/** `:root`, `html`, `:where(:root)` and their `:global(…)` forms: the default (non-theme) scope. */
export const isRootSelector = (selector: string) => ROOT_SELECTOR_RE.test(selector.trim());

/**
 * Pick the declaration that wins for a global lookup: shallowest, then a root-scope declaration over
 * theme or component overrides (`[data-theme="dark"]`, `.card`), then last in source order.
 */
export function pickDecl(decls: VarDecl[] | undefined): VarDecl | undefined {
	if (!decls?.length) return undefined;
	const rank = (d: VarDecl) => (isRootSelector(d.selector) ? 1 : 0);
	return decls.reduce((best, d) => {
		if (d.depth !== best.depth) return d.depth < best.depth ? d : best;
		return rank(d) >= rank(best) ? d : best;
	});
}

/** Resolve a value through nested `var()` references and fallbacks. Cycle-safe. */
export function resolveValue(
	value: string,
	vars: Map<string, VarDecl[]>,
	seen = new Set<string>(),
): string | undefined {
	const trimmed = value.trim();
	const expr = trimmed.startsWith("var(") ? readVar(trimmed, 0) : undefined;
	if (!expr?.closed || expr.end !== trimmed.length) return trimmed;
	const { name, fallback } = expr;
	if (seen.size > MAX_HOPS) return undefined;
	const decl = seen.has(name) ? undefined : pickDecl(vars.get(name));
	if (decl) {
		const resolved = resolveValue(decl.value, vars, new Set([...seen, name]));
		if (resolved !== undefined) return resolved;
	}
	return fallback === undefined ? undefined : resolveValue(fallback, vars, seen);
}

export function toColor(value: string | undefined): Rgba | undefined {
	if (!value) return undefined;
	const parsed = parse(value);
	if (!parsed) return undefined;
	const rgb = toRgb(parsed);
	const clamp = (n: number | undefined) => Math.min(1, Math.max(0, n ?? 0));
	return { red: clamp(rgb.r), green: clamp(rgb.g), blue: clamp(rgb.b), alpha: clamp(rgb.alpha ?? 1) };
}

export function varColor(
	name: string,
	fallback: string | undefined,
	vars: Map<string, VarDecl[]>,
): Rgba | undefined {
	const expr = fallback === undefined ? `var(${name})` : `var(${name}, ${fallback})`;
	return toColor(resolveValue(expr, vars));
}
