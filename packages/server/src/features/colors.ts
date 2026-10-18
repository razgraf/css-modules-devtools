import { varColor } from "@css-modules-devtools/core";
import type { ColorInformation } from "vscode-languageserver";
import type { DocParams } from "../context";
import { isScript } from "../lsp";
import { cssVarRefs, knownVarsFor, refRange, scriptVarRefs, type VarRef } from "./variables";

/**
 * F7b. Swatches on `var()` usages. Literal colors are left to the built-in CSS language service.
 * A reference nested in another's fallback gets no swatch of its own, so swatches never overlap.
 */
export function documentColors(p: DocParams): ColorInformation[] {
	let refs: VarRef[];
	if (isScript(p.file)) {
		if (!p.ctx.settings.variables.tsxStrings) return [];
		refs = scriptVarRefs(p.text);
	} else refs = cssVarRefs(p);
	if (!refs.length) return [];

	const vars = knownVarsFor(p);
	const colors: ColorInformation[] = [];
	let covered = -1;
	for (const ref of refs) {
		if (ref.start < covered) continue;
		covered = ref.end;
		const color = varColor(ref.name, ref.fallback, vars);
		if (color) colors.push({ range: refRange(p, ref), color });
	}
	return colors;
}
