import { type ParserPlugin, parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { LineIndex } from "../text";
import type { Loc } from "../types";

export const CSS_MODULE_RE = /\.module\.css(?:\?.*)?$/;

const STRING_QUERIES = ["inline", "url", "raw"];

/** Bundler queries (`?inline`, `?url`, `?raw`) turn the import into a string, not a class map. */
const isStringImport = (specifier: string) => {
	const query = /\?([^#]*)/.exec(specifier)?.[1];
	if (query === undefined) return false;
	const params = new URLSearchParams(query);
	return STRING_QUERIES.some((key) => params.has(key));
};

export type BindingKind = "default" | "namespace" | "named" | "require";

export interface ModuleBinding {
	/** Local identifier name. */
	local: string;
	kind: BindingKind;
	/** Exported key, for named bindings. */
	imported?: string;
	specifier: string;
	/** Location of the specifier text (inside the quotes). */
	specifierLoc: Loc;
}

export interface Usage {
	binding: ModuleBinding;
	/** `null` for dynamic access such as `styles[name]`. */
	key: string | null;
	bracket: boolean;
	loc: Loc;
}

export interface ModuleImport {
	specifier: string;
	specifierLoc: Loc;
}

export interface TsxInfo {
	file: string;
	/** Every top-level CSS-module import / require, side-effect ones (`import "./x.module.css"`) included. */
	imports: ModuleImport[];
	bindings: ModuleBinding[];
	usages: Usage[];
	/** Offset after the last top-level import / require, where new imports go. */
	importInsertOffset: number;
}

const SKIP_KEYS = new Set([
	"loc",
	"start",
	"end",
	"extra",
	"comments",
	"leadingComments",
	"trailingComments",
	"innerComments",
	"range",
	"tokens",
	"typeAnnotation",
	"returnType",
	"typeParameters",
]);

function plugins(file: string): ParserPlugin[] {
	if (/\.[cm]?tsx?$/.test(file)) return file.endsWith("x") ? ["typescript", "jsx"] : ["typescript"];
	return ["jsx"];
}

const isNode = (value: unknown): value is Node =>
	typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

type Visit = (node: Node, parent: Node | undefined, key: string, shadowed: ReadonlySet<string>) => void;

function patternNames(node: Node | null | undefined, out: string[]): void {
	if (!node) return;
	switch (node.type) {
		case "Identifier":
			out.push(node.name);
			break;
		case "ObjectPattern":
			for (const prop of node.properties)
				patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
			break;
		case "ArrayPattern":
			for (const element of node.elements) patternNames(element, out);
			break;
		case "AssignmentPattern":
			patternNames(node.left, out);
			break;
		case "RestElement":
			patternNames(node.argument, out);
			break;
		case "TSParameterProperty":
			patternNames(node.parameter, out);
			break;
	}
}

function lexicalNames(statements: Node[], out: string[]): void {
	for (const statement of statements) {
		if (statement.type === "VariableDeclaration") {
			if (statement.kind !== "var") for (const decl of statement.declarations) patternNames(decl.id, out);
		} else if (
			(statement.type === "FunctionDeclaration" ||
				statement.type === "ClassDeclaration" ||
				statement.type === "TSEnumDeclaration") &&
			statement.id
		) {
			out.push(statement.id.name);
		}
	}
}

/** `var` declarations hoisted to the enclosing function; stops at nested functions and classes. */
function varNames(node: Node | null | undefined, out: string[]): void {
	if (!node) return;
	switch (node.type) {
		case "VariableDeclaration":
			if (node.kind === "var") for (const decl of node.declarations) patternNames(decl.id, out);
			break;
		case "BlockStatement":
		case "StaticBlock":
			for (const statement of node.body) varNames(statement, out);
			break;
		case "IfStatement":
			varNames(node.consequent, out);
			varNames(node.alternate, out);
			break;
		case "ForStatement":
			varNames(node.init, out);
			varNames(node.body, out);
			break;
		case "ForInStatement":
		case "ForOfStatement":
			varNames(node.left, out);
			varNames(node.body, out);
			break;
		case "WhileStatement":
		case "DoWhileStatement":
		case "LabeledStatement":
		case "WithStatement":
			varNames(node.body, out);
			break;
		case "TryStatement":
			varNames(node.block, out);
			varNames(node.handler?.body, out);
			varNames(node.finalizer, out);
			break;
		case "SwitchStatement":
			for (const branch of node.cases) for (const statement of branch.consequent) varNames(statement, out);
			break;
	}
}

const SCOPE_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
	"ObjectMethod",
	"ClassMethod",
	"ClassPrivateMethod",
	"TSDeclareFunction",
	"TSDeclareMethod",
	"StaticBlock",
	"TSModuleBlock",
	"BlockStatement",
	"SwitchStatement",
	"CatchClause",
	"ForStatement",
	"ForInStatement",
	"ForOfStatement",
	"ClassExpression",
]);

/** Names a node declares for its children, or `undefined` when it opens no scope. The module scope is never one. */
function scopeNames(node: Node): string[] | undefined {
	if (!SCOPE_TYPES.has(node.type)) return undefined;
	const names: string[] = [];
	switch (node.type) {
		case "FunctionDeclaration":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ObjectMethod":
		case "ClassMethod":
		case "ClassPrivateMethod":
		case "TSDeclareFunction":
		case "TSDeclareMethod":
			if (node.type === "FunctionExpression" && node.id) names.push(node.id.name);
			for (const param of node.params) patternNames(param, names);
			if (node.type !== "TSDeclareFunction" && node.type !== "TSDeclareMethod") varNames(node.body, names);
			return names;
		case "StaticBlock":
		case "TSModuleBlock":
			varNames(node, names);
			lexicalNames(node.body, names);
			return names;
		case "BlockStatement":
			lexicalNames(node.body, names);
			return names;
		case "SwitchStatement":
			for (const branch of node.cases) lexicalNames(branch.consequent, names);
			return names;
		case "CatchClause":
			patternNames(node.param, names);
			return names;
		case "ForStatement":
			if (node.init?.type === "VariableDeclaration") lexicalNames([node.init], names);
			return names;
		case "ForInStatement":
		case "ForOfStatement":
			lexicalNames([node.left], names);
			return names;
		case "ClassExpression":
			if (node.id) names.push(node.id.name);
			return names;
		default:
			return undefined;
	}
}

/** Walks the AST tracking which of `tracked` are shadowed by a nearer declaration than the module binding. */
function walk(
	node: Node,
	tracked: ReadonlySet<string>,
	visit: Visit,
	shadowed: ReadonlySet<string> = new Set(),
	parent?: Node,
	key = "",
) {
	visit(node, parent, key, shadowed);
	let inner = shadowed;
	const declared = scopeNames(node)?.filter((name) => tracked.has(name) && !shadowed.has(name));
	if (declared?.length) inner = new Set([...shadowed, ...declared]);
	for (const [k, value] of Object.entries(node)) {
		if (SKIP_KEYS.has(k)) continue;
		const scope = node.type === "SwitchStatement" && k === "discriminant" ? shadowed : inner;
		if (Array.isArray(value)) {
			for (const child of value) if (isNode(child)) walk(child, tracked, visit, scope, node, k);
		} else if (isNode(value)) {
			walk(value, tracked, visit, scope, node, k);
		}
	}
}

export function analyzeTsx(file: string, text: string): TsxInfo | undefined {
	let ast: ReturnType<typeof parse>;
	try {
		ast = parse(text, {
			sourceType: "module",
			plugins: plugins(file),
			errorRecovery: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
		});
	} catch {
		return undefined;
	}

	const index = new LineIndex(text);
	const locOf = (start: number, end: number) => index.loc(file, start, end);
	const stringLoc = (node: Node) => locOf((node.start ?? 0) + 1, (node.end ?? 0) - 1);

	const imports: ModuleImport[] = [];
	const bindings: ModuleBinding[] = [];
	const usages: Usage[] = [];
	const declarationSites = new Set<number>();
	let importInsertOffset = 0;

	for (const statement of ast.program.body) {
		if (statement.type === "ImportDeclaration") {
			importInsertOffset = statement.end ?? importInsertOffset;
			const specifier = statement.source.value;
			if (!CSS_MODULE_RE.test(specifier)) continue;
			const specifierLoc = stringLoc(statement.source);
			imports.push({ specifier, specifierLoc });
			if (isStringImport(specifier)) continue;
			for (const spec of statement.specifiers) {
				if (spec.type === "ImportDefaultSpecifier") {
					bindings.push({ local: spec.local.name, kind: "default", specifier, specifierLoc });
				} else if (spec.type === "ImportNamespaceSpecifier") {
					bindings.push({ local: spec.local.name, kind: "namespace", specifier, specifierLoc });
				} else {
					const importedNode = spec.imported;
					const imported = importedNode.type === "Identifier" ? importedNode.name : importedNode.value;
					if (imported === "default") {
						bindings.push({ local: spec.local.name, kind: "default", specifier, specifierLoc });
						continue;
					}
					const binding: ModuleBinding = {
						local: spec.local.name,
						kind: "named",
						imported,
						specifier,
						specifierLoc,
					};
					bindings.push(binding);
					const isString = importedNode.type === "StringLiteral";
					usages.push({
						binding,
						key: imported,
						bracket: false,
						loc: isString ? stringLoc(importedNode) : locOf(importedNode.start ?? 0, importedNode.end ?? 0),
					});
				}
			}
		} else if (statement.type === "VariableDeclaration") {
			let isRequire = false;
			for (const decl of statement.declarations) {
				const init = decl.init;
				if (
					init?.type !== "CallExpression" ||
					init.callee.type !== "Identifier" ||
					init.callee.name !== "require" ||
					init.arguments[0]?.type !== "StringLiteral"
				) {
					continue;
				}
				isRequire = true;
				const source = init.arguments[0];
				const specifier = source.value;
				if (!CSS_MODULE_RE.test(specifier)) continue;
				const specifierLoc = stringLoc(source);
				imports.push({ specifier, specifierLoc });
				if (isStringImport(specifier)) continue;
				if (decl.id.type === "Identifier") {
					bindings.push({ local: decl.id.name, kind: "require", specifier, specifierLoc });
				} else if (decl.id.type === "ObjectPattern") {
					for (const prop of decl.id.properties) {
						if (prop.type !== "ObjectProperty" || prop.value.type !== "Identifier") continue;
						const key = prop.key;
						const imported =
							key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : undefined;
						if (!imported) continue;
						const binding: ModuleBinding = {
							local: prop.value.name,
							kind: "named",
							imported,
							specifier,
							specifierLoc,
						};
						bindings.push(binding);
						declarationSites.add(prop.value.start ?? -1);
						usages.push({
							binding,
							key: imported,
							bracket: false,
							loc: key.type === "StringLiteral" ? stringLoc(key) : locOf(key.start ?? 0, key.end ?? 0),
						});
					}
				}
			}
			if (isRequire) importInsertOffset = statement.end ?? importInsertOffset;
		} else if (statement.type === "ExpressionStatement") {
			const call = statement.expression;
			const source = call.type === "CallExpression" ? call.arguments[0] : undefined;
			if (
				call.type !== "CallExpression" ||
				call.callee.type !== "Identifier" ||
				call.callee.name !== "require" ||
				source?.type !== "StringLiteral"
			) {
				continue;
			}
			importInsertOffset = statement.end ?? importInsertOffset;
			if (CSS_MODULE_RE.test(source.value))
				imports.push({ specifier: source.value, specifierLoc: stringLoc(source) });
		}
	}

	if (bindings.length === 0) return { file, imports, bindings, usages, importInsertOffset };

	const objects = new Map(bindings.filter((b) => b.kind !== "named").map((b) => [b.local, b]));
	const named = new Map(bindings.filter((b) => b.kind === "named").map((b) => [b.local, b]));
	// Declaration sites were recorded above; skip them (and shorthand duplicates) during the walk.
	const seen = new Set([...declarationSites, ...usages.map((u) => u.loc.start.offset)]);

	const tracked = new Set(bindings.map((b) => b.local));

	walk(ast.program, tracked, (node, parent, key, shadowed) => {
		if (
			(node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
			node.object.type === "Identifier"
		) {
			const binding = objects.get(node.object.name);
			if (!binding || shadowed.has(node.object.name)) return;
			const prop = node.property;
			if (!node.computed && prop.type === "Identifier") {
				usages.push({ binding, key: prop.name, bracket: false, loc: locOf(prop.start ?? 0, prop.end ?? 0) });
			} else if (prop.type === "StringLiteral") {
				usages.push({ binding, key: prop.value, bracket: true, loc: stringLoc(prop) });
			} else if (prop.type === "TemplateLiteral" && prop.expressions.length === 0) {
				const quasi = prop.quasis[0];
				usages.push({
					binding,
					key: quasi?.value.cooked ?? "",
					bracket: true,
					loc: locOf((prop.start ?? 0) + 1, (prop.end ?? 0) - 1),
				});
			} else {
				usages.push({ binding, key: null, bracket: true, loc: locOf(prop.start ?? 0, prop.end ?? 0) });
			}
			return;
		}

		if (node.type !== "Identifier" || !named.has(node.name) || !parent || shadowed.has(node.name)) return;
		if (seen.has(node.start ?? -1)) return;
		const isDeclaration = parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier";
		const isPropertyName =
			((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
				key === "property" &&
				!parent.computed) ||
			(parent.type === "ObjectProperty" && key === "key" && !parent.computed && !parent.shorthand) ||
			(parent.type === "ObjectMethod" && key === "key");
		if (isDeclaration || isPropertyName) return;
		seen.add(node.start ?? -1);
		const binding = named.get(node.name);
		if (!binding?.imported) return;
		usages.push({
			binding,
			key: binding.imported,
			bracket: false,
			loc: locOf(node.start ?? 0, node.end ?? 0),
		});
	});

	return { file, imports, bindings, usages, importInsertOffset };
}
