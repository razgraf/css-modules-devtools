import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Loc, Severity } from "@css-modules-devtools/core";
import { DiagnosticSeverity, type Location, type Range } from "vscode-languageserver";

export const toPath = (uri: string) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri);

export const toUri = (file: string) =>
	file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) ? pathToFileURL(file).href : file;

export const toRange = (loc: Loc): Range => ({
	start: { line: loc.start.line, character: loc.start.character },
	end: { line: loc.end.line, character: loc.end.character },
});

export const toLocation = (loc: Loc): Location => ({ uri: toUri(loc.file), range: toRange(loc) });

export function toSeverity(severity: Severity): DiagnosticSeverity | undefined {
	switch (severity) {
		case "error":
			return DiagnosticSeverity.Error;
		case "warning":
			return DiagnosticSeverity.Warning;
		case "info":
			return DiagnosticSeverity.Information;
		case "hint":
			return DiagnosticSeverity.Hint;
		case "off":
			return undefined;
	}
}

export const isCss = (file: string) => file.endsWith(".css");

export const isCssModule = (file: string) => file.endsWith(".module.css");

export const isScript = (file: string) => /\.[cm]?[jt]sx?$/.test(file);

export const SOURCE = "css-modules-devtools";

/** A key usable as `obj.key` (otherwise it needs bracket access). */
export const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Import specifier for `target` from the file `from`: `../x` or `./x`, always forward slashes. */
export function relativeSpecifier(target: string, from: string): string {
	const rel = path.relative(path.dirname(from), target).split(path.sep).join("/");
	return rel.startsWith("../") ? rel : `./${rel}`;
}
