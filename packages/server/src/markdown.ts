import type { ClassDef, CssInfo, Loc } from "@css-modules-devtools/core";
import { toUri } from "./lsp";

/** A fenced css block of `lines`, cut after `maxLines` (0 = no limit) with a trailing `…`. */
export function cssBlock(lines: string[], maxLines: number): { value: string; truncated: boolean } {
	const truncated = maxLines > 0 && lines.length > maxLines;
	const shown = truncated ? [...lines.slice(0, maxLines), "…"] : lines;
	return { value: ["```css", ...shown, "```"].join("\n"), truncated };
}

export const fileLink = (label: string, loc: Loc) => `[${label}](${toUri(loc.file)}#L${loc.start.line + 1})`;

/** First definition of `name` in the stylesheet, local classes before `:global` ones. */
export const firstDef = (info: CssInfo | undefined, name: string): ClassDef | undefined =>
	(info?.classes.get(name) ?? info?.globals.get(name))?.[0];
