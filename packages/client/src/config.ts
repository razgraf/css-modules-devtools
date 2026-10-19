// The `types` entry keeps core's parsers (~1.5 MB) out of the client bundle.
import {
	type Convention,
	type DiagnosticRule,
	defaultSettings,
	type ImportSpecifierPreference,
	type Settings,
	type Severity,
} from "@css-modules-devtools/core/types";
import type { Configuration } from "@css-modules-devtools/server";

export type { Configuration };

export const SECTION = "cssModulesDevTools";
export const CONFIGURE_NOTIFICATION = "cssModulesDevTools/configure";
export const CMK_EXTENSION = "mizdra.css-modules-kit-vscode";

/** Sections whose changes require re-sending the configuration. */
export const WATCHED_SECTIONS = [
	SECTION,
	"cssModules.pathAlias",
	"cssVariables.lookupFiles",
	"typescript.preferences.importModuleSpecifier",
	"typescript.experimental.useTsgo",
];

export interface Setting {
	value: unknown;
	/** Set explicitly at user, workspace or folder level (defaults don't count). */
	userSet: boolean;
}

export type Reader = (section: string, key: string) => Setting;

/** The levels of `WorkspaceConfiguration.inspect` we look at. */
export interface Inspection {
	defaultValue?: unknown;
	globalValue?: unknown;
	workspaceValue?: unknown;
	workspaceFolderValue?: unknown;
	globalLanguageValue?: unknown;
	workspaceLanguageValue?: unknown;
	workspaceFolderLanguageValue?: unknown;
}

/**
 * Other extensions' settings that stand in for our restricted ones. VS Code only drops workspace values of
 * the settings our manifest lists, so in an untrusted workspace these are read from user settings only.
 */
export const RESTRICTED_FALLBACKS: ReadonlySet<string> = new Set([
	"cssModules.pathAlias",
	"cssVariables.lookupFiles",
]);

export function setting(id: string, value: unknown, info: Inspection | undefined, trusted: boolean): Setting {
	if (!trusted && RESTRICTED_FALLBACKS.has(id)) {
		const user = info?.globalValue;
		return { value: user ?? info?.defaultValue, userSet: user !== undefined };
	}
	const levels = [
		info?.globalValue,
		info?.workspaceValue,
		info?.workspaceFolderValue,
		info?.globalLanguageValue,
		info?.workspaceLanguageValue,
		info?.workspaceFolderLanguageValue,
	];
	return { value, userSet: levels.some((level) => level !== undefined) };
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const TSX_MODES = ["auto", "on", "off"] as const;
const CONVENTIONS: readonly Convention[] = ["asIs", "camelCase", "camelCaseOnly", "dashes", "dashesOnly"];
export const SEVERITIES: readonly Severity[] = ["off", "hint", "info", "warning", "error"];
const SPECIFIERS: readonly ImportSpecifierPreference[] = [
	"shortest",
	"relative",
	"non-relative",
	"project-relative",
];

export function buildConfiguration(read: Reader, installed: (id: string) => boolean): Configuration {
	const own = (key: string) => read(SECTION, key).value;
	const defaults = defaultSettings;

	const settings: Settings = {
		tsx: { enabled: oneOf(own("tsx.enabled"), TSX_MODES, defaults.tsx.enabled) },
		completion: { enabled: bool(own("completion.enabled"), defaults.completion.enabled) },
		definition: { enabled: bool(own("definition.enabled"), defaults.definition.enabled) },
		hover: {
			enabled: bool(own("hover.enabled"), defaults.hover.enabled),
			maxLines: int(own("hover.maxLines"), 1, defaults.hover.maxLines),
		},
		autoImport: {
			enabled: bool(own("autoImport.enabled"), defaults.autoImport.enabled),
			importModuleSpecifier: oneOf(
				read("typescript", "preferences.importModuleSpecifier").value,
				SPECIFIERS,
				defaults.autoImport.importModuleSpecifier,
			),
			identifiers: identifiers(own("autoImport.identifiers")),
		},
		variables: {
			enabled: bool(own("variables.enabled"), defaults.variables.enabled),
			tsxStrings: bool(own("variables.tsxStrings"), defaults.variables.tsxStrings),
			colors: bool(own("variables.colors"), defaults.variables.colors),
		},
		classNameConvention: oneOf(own("classNameConvention"), CONVENTIONS, defaults.classNameConvention),
		pathAlias: pathAlias(read),
		globalFiles: globalFiles(read),
		varShadow: { maxDepth: int(own("varShadow.maxDepth"), -1, defaults.varShadow.maxDepth) },
		nodeModules: { enabled: bool(own("nodeModules.enabled"), defaults.nodeModules.enabled) },
		diagnostics: diagnostics(own("diagnostics")),
	};

	return {
		settings,
		env: {
			cmkExtension: installed(CMK_EXTENSION),
			useTsgo: read("typescript", "experimental.useTsgo").value === true,
		},
	};
}

/** Ours when set; otherwise clinyong's `cssModules.pathAlias` (same shape). */
function pathAlias(read: Reader): Record<string, string> {
	const own = read(SECTION, "pathAlias");
	const ours = stringRecord(own.value);
	if (own.userSet && ours) return ours;
	const legacy = stringRecord(read("cssModules", "pathAlias").value);
	if (legacy && Object.keys(legacy).length > 0) return legacy;
	return ours ?? { ...defaultSettings.pathAlias };
}

/**
 * Ours when set; otherwise `cssVariables.lookupFiles`, but only when the user set it explicitly:
 * its default globs (`**\/*.css` …) would turn every stylesheet into a global one.
 */
function globalFiles(read: Reader): string[] {
	const own = read(SECTION, "globalFiles");
	const ours = stringArray(own.value);
	if (own.userSet && ours) return ours;
	const legacy = read("cssVariables", "lookupFiles");
	const legacyFiles = stringArray(legacy.value);
	if (legacy.userSet && legacyFiles) return legacyFiles;
	return ours ?? [...defaultSettings.globalFiles];
}

/** Valid, unique JS identifiers; an explicit empty list disables auto-import. */
function identifiers(value: unknown): string[] {
	if (!Array.isArray(value)) return [...defaultSettings.autoImport.identifiers];
	const names = value.filter((item): item is string => typeof item === "string" && IDENT_RE.test(item));
	return [...new Set(names)];
}

function diagnostics(value: unknown): Record<DiagnosticRule, Severity> {
	const result = { ...defaultSettings.diagnostics };
	if (!isRecord(value)) return result;
	for (const rule of Object.keys(result) as DiagnosticRule[]) {
		result[rule] = oneOf(value[rule], SEVERITIES, result[rule]);
	}
	return result;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return allowed.find((item) => item === value) ?? fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, min: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, string> = {};
	for (const [key, target] of Object.entries(value)) {
		if (typeof target === "string" && key.length > 0) result[key] = target;
	}
	return result;
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}
