export interface Pos {
	line: number;
	character: number;
	offset: number;
}

export interface Loc {
	file: string;
	start: Pos;
	end: Pos;
}

export interface Decl {
	prop: string;
	value: string;
	loc: Loc;
}

export interface RuleInfo {
	/** Selector with `&` resolved against parent rules. */
	selector: string;
	/** Enclosing at-rules, outermost first, e.g. `@media (min-width: 40rem)`. */
	wrappers: string[];
	declarations: Decl[];
	/** All class names (local and global) referenced by the resolved selector. */
	classes: Set<string>;
	depth: number;
	loc: Loc;
}

export interface ClassDef {
	name: string;
	loc: Loc;
	rule: RuleInfo;
}

export interface NameRef {
	name: string;
	loc: Loc;
}

export interface Composes {
	names: NameRef[];
	/** `null` = same file, `"global"` = `from global`. */
	from: { specifier: string; loc: Loc } | "global" | null;
	/** Local classes of the rule the declaration lives in. */
	owners: string[];
	loc: Loc;
}

export interface VarDecl {
	name: string;
	value: string;
	/** Rule nesting depth; at-rules don't count. `@property` declarations have depth 0. */
	depth: number;
	selector: string;
	loc: Loc;
}

export interface VarUse {
	name: string;
	fallback: string | undefined;
	/** The name, e.g. `--brand`. */
	loc: Loc;
	/** The whole `var(…)` expression; ends after the name while the paren is unclosed. */
	expr: Loc;
}

export interface ImportRef {
	specifier: string;
	loc: Loc;
}

export interface CssInfo {
	file: string;
	/** Local (exported) classes. */
	classes: Map<string, ClassDef[]>;
	/** Classes declared through `:global`. */
	globals: Map<string, ClassDef[]>;
	rules: RuleInfo[];
	composes: Composes[];
	varDecls: VarDecl[];
	varUses: VarUse[];
	imports: ImportRef[];
}

export type Convention = "asIs" | "camelCase" | "camelCaseOnly" | "dashes" | "dashesOnly";

export type Severity = "off" | "hint" | "info" | "warning" | "error";

export type DiagnosticRule =
	| "missingClass"
	| "missingFile"
	| "varShadowsGlobal"
	| "globalClassCollision"
	| "localShadowsGlobal";

export type ImportSpecifierPreference = "shortest" | "relative" | "non-relative" | "project-relative";

export interface Settings {
	tsx: { enabled: "auto" | "on" | "off" };
	completion: { enabled: boolean };
	definition: { enabled: boolean };
	hover: { enabled: boolean; maxLines: number };
	autoImport: {
		enabled: boolean;
		importModuleSpecifier: ImportSpecifierPreference;
		/** Unbound identifiers that trigger auto-import on `name.`. */
		identifiers: string[];
	};
	variables: { enabled: boolean; tsxStrings: boolean; colors: boolean };
	classNameConvention: Convention;
	pathAlias: Record<string, string>;
	globalFiles: string[];
	varShadow: { maxDepth: number };
	nodeModules: { enabled: boolean };
	diagnostics: Record<DiagnosticRule, Severity>;
}

export const defaultSettings: Settings = {
	tsx: { enabled: "auto" },
	completion: { enabled: true },
	definition: { enabled: true },
	hover: { enabled: true, maxLines: 30 },
	autoImport: {
		enabled: true,
		importModuleSpecifier: "shortest",
		identifiers: ["styles", "classes", "css", "s"],
	},
	variables: { enabled: true, tsxStrings: true, colors: true },
	classNameConvention: "asIs",
	pathAlias: {},
	globalFiles: [],
	varShadow: { maxDepth: 0 },
	nodeModules: { enabled: false },
	diagnostics: {
		missingClass: "error",
		missingFile: "error",
		varShadowsGlobal: "warning",
		globalClassCollision: "warning",
		localShadowsGlobal: "off",
	},
};
