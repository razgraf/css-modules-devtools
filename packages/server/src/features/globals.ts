import path from "node:path";
import type { CssInfo, DiagnosticRule, GlobalScope, Loc } from "@css-modules-devtools/core";
import type { Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity } from "vscode-languageserver";
import type { DocParams } from "../context";
import { isCssModule, SOURCE, toLocation, toRange, toSeverity } from "../lsp";

/** F8. `varShadowsGlobal`, `globalClassCollision`, `localShadowsGlobal`. */
export function globalDiagnostics(p: DocParams): Diagnostic[] {
	const { project, settings } = p.ctx;
	const severity = (rule: DiagnosticRule) => toSeverity(settings.diagnostics[rule]);
	const shadow = severity("varShadowsGlobal");
	const collision = severity("globalClassCollision");
	const localShadow = severity("localShadowsGlobal");
	if (!shadow && !collision && !localShadow) return [];

	const info = project.cssInfo(p.file);
	if (!info) return [];
	const scope = project.globalScope(p.file);
	const out: Diagnostic[] = [];
	if (shadow) out.push(...varShadows(p, info, scope, shadow));
	if (isCssModule(p.file)) {
		if (collision) out.push(...collisions(p, info, scope, collision));
		if (localShadow) out.push(...localShadows(p, info, scope, localShadow));
	}
	return out;
}

function varShadows(p: DocParams, info: CssInfo, scope: GlobalScope, severity: DiagnosticSeverity) {
	// Global files may redeclare their own variables (theme overrides such as `[data-theme="dark"]`).
	if (scope.files.includes(p.file)) return [];
	const { maxDepth } = p.ctx.settings.varShadow;
	const out: Diagnostic[] = [];
	for (const decl of info.varDecls) {
		if (maxDepth >= 0 && decl.depth > maxDepth) continue;
		const originals = (scope.vars.get(decl.name) ?? []).filter((d) => d.loc.file !== p.file);
		if (originals.length === 0) continue;
		out.push(
			diagnostic(
				decl.loc,
				severity,
				"varShadowsGlobal",
				`'${decl.name}' shadows a global variable declared in ${files(originals)}.`,
				related(originals, `Global declaration of '${decl.name}'`),
			),
		);
	}
	return out;
}

function collisions(p: DocParams, info: CssInfo, scope: GlobalScope, severity: DiagnosticSeverity) {
	const { project } = p.ctx;
	const excluded = new Set([p.file, ...scope.files]);
	// Each package (e.g. a monorepo app) is bundled separately, so its :global classes can't clash with another's.
	const rootOf = (file: string) =>
		project.resolver.packageRoot(file) ?? project.resolver.workspaceFolder(file);
	const root = rootOf(p.file);
	const others = project
		.indexedFiles()
		.filter((f) => isCssModule(f) && !excluded.has(f) && rootOf(f) === root)
		.sort()
		.map((f) => project.cssInfo(f))
		.filter((i): i is CssInfo => i !== undefined);

	const out: Diagnostic[] = [];
	for (const [name, defs] of info.globals) {
		const clashes = [
			...(scope.classes.get(name) ?? []).filter((d) => d.loc.file !== p.file),
			...others.flatMap((o) => o.globals.get(name) ?? []),
		];
		if (clashes.length === 0) continue;
		for (const def of defs) {
			out.push(
				diagnostic(
					def.loc,
					severity,
					"globalClassCollision",
					`Global class '.${name}' is also defined in ${files(clashes)}.`,
					related(clashes, `'.${name}' defined here`),
				),
			);
		}
	}
	return out;
}

function localShadows(p: DocParams, info: CssInfo, scope: GlobalScope, severity: DiagnosticSeverity) {
	const out: Diagnostic[] = [];
	for (const [name, defs] of info.classes) {
		const globals = (scope.classes.get(name) ?? []).filter((d) => d.loc.file !== p.file);
		if (globals.length === 0) continue;
		for (const def of defs) {
			out.push(
				diagnostic(
					def.loc,
					severity,
					"localShadowsGlobal",
					`Local class '.${name}' shadows a global class in ${files(globals)}.`,
					related(globals, `Global '.${name}'`),
				),
			);
		}
	}
	return out;
}

function diagnostic(
	loc: Loc,
	severity: DiagnosticSeverity,
	code: DiagnosticRule,
	message: string,
	relatedInformation: DiagnosticRelatedInformation[],
): Diagnostic {
	return { range: toRange(loc), severity, source: SOURCE, code, message, relatedInformation };
}

function related(defs: { loc: Loc }[], message: string): DiagnosticRelatedInformation[] {
	return defs.map((d) => ({ location: toLocation(d.loc), message }));
}

function files(defs: { loc: Loc }[]): string {
	return [...new Set(defs.map((d) => path.basename(d.loc.file)))].join(", ");
}
