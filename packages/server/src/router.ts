import { cssContext, scriptContext } from "@css-modules-devtools/core";
import type {
	CodeAction,
	CodeActionParams,
	ColorInformation,
	CompletionItem,
	Diagnostic,
	Hover,
	Location,
	LocationLink,
} from "vscode-languageserver";
import type { DocParams, FeatureContext } from "./context";
import { autoImportCompletions } from "./features/autoImport";
import {
	type ClassItemData,
	classCompletions,
	classDefinition,
	classHover,
	resolveClassCompletion,
} from "./features/classes";
import { documentColors } from "./features/colors";
import { composesCompletions, composesDefinition, composesHover } from "./features/composes";
import { globalDiagnostics } from "./features/globals";
import { cssMissingDiagnostics, quickFixes, scriptDiagnostics } from "./features/missing";
import { varCompletions, varDefinition, varHover } from "./features/variables";
import { isCss, isScript } from "./lsp";

export function completion(p: DocParams): CompletionItem[] {
	const { settings } = p.ctx;
	if (isScript(p.file)) {
		const c = scriptContext(p.text, p.offset);
		if (!c) return [];
		if (c.kind === "var") {
			return settings.variables.enabled && settings.variables.tsxStrings ? varCompletions(p, c) : [];
		}
		if (!settings.completion.enabled || !p.ctx.tsxEnabled(p.file)) return [];
		const items = classCompletions(p, c);
		if (items) return items;
		return c.kind === "member" && settings.autoImport.enabled ? autoImportCompletions(p, c) : [];
	}
	if (isCss(p.file)) {
		const c = cssContext(p.text, p.offset);
		if (!c) return [];
		if (c.kind === "var") return settings.variables.enabled ? varCompletions(p, c) : [];
		return settings.completion.enabled ? composesCompletions(p, c) : [];
	}
	return [];
}

/** Fills in what `completion` defers (documentation), dispatching on the item's `data.kind`. */
export function resolveCompletion(ctx: FeatureContext, item: CompletionItem): CompletionItem {
	const data: unknown = item.data;
	if (isClassData(data)) return resolveClassCompletion(ctx, item, data);
	return item;
}

function isClassData(value: unknown): value is ClassItemData {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "class" &&
		"file" in value &&
		typeof value.file === "string" &&
		"name" in value &&
		typeof value.name === "string"
	);
}

export function definition(p: DocParams): Location[] | LocationLink[] | undefined {
	const { settings } = p.ctx;
	if (!settings.definition.enabled) return undefined;
	const vars = () => (settings.variables.enabled ? varDefinition(p) : undefined);
	if (isScript(p.file)) return (p.ctx.tsxEnabled(p.file) ? classDefinition(p) : undefined) ?? vars();
	if (isCss(p.file)) return composesDefinition(p) ?? vars();
	return undefined;
}

export function hover(p: DocParams): Hover | undefined {
	const { settings } = p.ctx;
	if (!settings.hover.enabled) return undefined;
	const vars = () => (settings.variables.enabled ? varHover(p) : undefined);
	if (isScript(p.file)) return (p.ctx.tsxEnabled(p.file) ? classHover(p) : undefined) ?? vars();
	if (isCss(p.file)) return composesHover(p) ?? vars();
	return undefined;
}

export function diagnostics(p: DocParams): Diagnostic[] {
	if (isScript(p.file)) return p.ctx.tsxEnabled(p.file) ? scriptDiagnostics(p) : [];
	if (isCss(p.file)) return [...cssMissingDiagnostics(p), ...globalDiagnostics(p)];
	return [];
}

export function codeActions(p: DocParams, params: CodeActionParams): CodeAction[] {
	return quickFixes(p, params);
}

export function colors(p: DocParams): ColorInformation[] {
	const { variables } = p.ctx.settings;
	return variables.enabled && variables.colors ? documentColors(p) : [];
}
