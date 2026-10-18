import { describe, expect, test } from "bun:test";
import { defaultSettings, type Settings } from "@css-modules-devtools/core";
import { type CodeAction, type Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DocParams } from "../src/context";
import { SOURCE, toUri } from "../src/lsp";
import { codeActions, diagnostics } from "../src/router";
import { fixture, read, setup } from "./helpers";

const severities = (overrides: Partial<Settings["diagnostics"]>) => ({
	diagnostics: { ...defaultSettings.diagnostics, ...overrides },
});

const textAt = (p: DocParams, d: Diagnostic) =>
	p.text.slice(p.doc.offsetAt(d.range.start), p.doc.offsetAt(d.range.end));

const summary = (p: DocParams) => diagnostics(p).map((d) => [d.code, textAt(p, d)]);

function fixes(p: DocParams): CodeAction[] {
	const all = diagnostics(p);
	return codeActions(p, {
		textDocument: { uri: p.doc.uri },
		range: all[0]?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		context: { diagnostics: all },
	});
}

/** Text of `file` after applying the action's edits to it. */
function applied(action: CodeAction | undefined, file: string, text: string): string {
	const edits = action?.edit?.changes?.[toUri(file)] ?? [];
	return TextDocument.applyEdits(TextDocument.create(toUri(file), "css", 1, text), edits);
}

const BUTTON = "src/components/Button.tsx";
const BUTTON_CSS = fixture("next-app", "src/components/Button.module.css");

describe("script diagnostics", () => {
	test("unknown key on a default import; dynamic access ignored", () => {
		const p = setup("next-app").open(BUTTON);
		const all = diagnostics(p);
		expect(all).toHaveLength(1);
		const [d] = all;
		expect(d?.code).toBe("missingClass");
		expect(d?.source).toBe(SOURCE);
		expect(d?.severity).toBe(DiagnosticSeverity.Error);
		expect(d?.message).toBe("Class 'missing' does not exist in Button.module.css");
		expect(d && textAt(p, d)).toBe("missing");
		expect(d?.data).toEqual({ rule: "missingClass", key: "missing", file: BUTTON_CSS, shape: "member" });
	});

	test("named, namespace and require bindings", () => {
		const { open } = setup("next-app");
		expect(diagnostics(open("src/components/Card.tsx"))).toEqual([]);

		const p = open(
			"src/components/Card.tsx",
			[
				'import { cart, card as c } from "./Card.module.css";',
				'import * as ns from "./Card.module.css";',
				'const legacy = require("./Button.module.css");',
				'const { buton: b, icon } = require("./Button.module.css");',
				"export const X = () => [cart, cart, c, ns.nope, legacy.nope, legacy['icn'], b, icon];",
			].join("\n"),
		);
		// `cart` is flagged once, at the import, not at each reference.
		expect(summary(p)).toEqual([
			["missingClass", "cart"],
			["missingClass", "buton"],
			["missingClass", "nope"],
			["missingClass", "nope"],
			["missingClass", "icn"],
		]);
	});

	test("unresolvable import → missingFile once; alias imports resolve", () => {
		const theme = { pathAlias: { "@theme": "${workspaceFolder}/src/theme" } };
		const p = setup("aliases", theme).open("src/components/X.tsx");
		const all = diagnostics(p);
		expect(all.map((d) => [d.code, textAt(p, d)])).toEqual([["missingFile", "./does-not-exist.module.css"]]);
		expect(all[0]?.message).toBe("Cannot find stylesheet './does-not-exist.module.css'");

		// Without the pathAlias setting `@theme/…` doesn't resolve either.
		expect(summary(setup("aliases").open("src/components/X.tsx"))).toEqual([
			["missingFile", "@theme/theme.module.css"],
			["missingFile", "./does-not-exist.module.css"],
		]);
	});

	test("one missingFile per import statement", () => {
		const p = setup("aliases").open(
			"src/components/X.tsx",
			'import d, { x } from "./gone.module.css";\nimport a from "~styles/a.module.css";\na.nope; d.y; x;',
		);
		expect(summary(p)).toEqual([
			["missingFile", "./gone.module.css"],
			["missingClass", "nope"],
		]);
	});

	test("side-effect import and bare require → missingFile", () => {
		const p = setup("aliases").open(
			"src/components/X.tsx",
			'import "./gone.module.css";\nimport "~styles/a.module.css";\nrequire("./lost.module.css");\n',
		);
		expect(summary(p)).toEqual([
			["missingFile", "./gone.module.css"],
			["missingFile", "./lost.module.css"],
		]);
	});

	test("monorepo: tsconfig paths per app", () => {
		const { open } = setup("monorepo");
		expect(diagnostics(open("apps/docs/app/Page.tsx"))).toEqual([]);
		expect(diagnostics(open("apps/web/src/components/Hero.tsx"))).toEqual([]);
		const p = open(
			"apps/web/src/components/Hero.tsx",
			'import styles from "@/components/Hero.module.css";\nstyles.heroo;',
		);
		expect(diagnostics(p).map((d) => d.message)).toEqual(["Class 'heroo' does not exist in Hero.module.css"]);
	});

	test("classNameConvention decides the exported keys", () => {
		const text = 'import styles from "./Button.module.css";\nstyles.primaryAction; styles["primary-action"];';
		expect(summary(setup("next-app").open(BUTTON, text))).toEqual([["missingClass", "primaryAction"]]);
		expect(summary(setup("next-app", { classNameConvention: "camelCase" }).open(BUTTON, text))).toEqual([]);
		expect(summary(setup("next-app", { classNameConvention: "camelCaseOnly" }).open(BUTTON, text))).toEqual([
			["missingClass", "primary-action"],
		]);
	});

	test("severity mapping and off", () => {
		const hint = setup("next-app", severities({ missingClass: "hint" })).open(BUTTON);
		expect(diagnostics(hint).map((d) => d.severity)).toEqual([DiagnosticSeverity.Hint]);

		expect(diagnostics(setup("next-app", severities({ missingClass: "off" })).open(BUTTON))).toEqual([]);

		const noFile = setup("aliases", severities({ missingFile: "warning", missingClass: "off" }));
		const all = diagnostics(noFile.open("src/components/X.tsx"));
		expect(all.map((d) => d.severity)).toEqual([DiagnosticSeverity.Warning, DiagnosticSeverity.Warning]);
		expect(
			diagnostics(setup("aliases", severities({ missingFile: "off" })).open("src/components/X.tsx")),
		).toEqual([]);
	});

	test("tsx.enabled off disables script diagnostics", () => {
		expect(diagnostics(setup("next-app", { tsx: { enabled: "off" } }).open(BUTTON))).toEqual([]);
	});
});

describe("stylesheet diagnostics", () => {
	const CARD_CSS = "src/components/Card.module.css";

	test("fixture modules are clean", () => {
		const { open } = setup("next-app");
		expect(diagnostics(open("src/components/Button.module.css"))).toEqual([]);
		expect(diagnostics(open(CARD_CSS))).toEqual([]);
		expect(diagnostics(open("src/styles/base.module.css"))).toEqual([]);
		expect(diagnostics(open("src/app/globals.css"))).toEqual([]);
		expect(diagnostics(setup("monorepo").open("apps/web/src/components/Hero.module.css"))).toEqual([]);
	});

	test("composes names: same file, relative, alias, package, global", () => {
		const p = setup("next-app").open(
			CARD_CSS,
			[
				".card {",
				"\tcomposes: local nope;",
				'\tcomposes: button buton from "./Button.module.css";',
				'\tcomposes: focusabl from "@/styles/base.module.css";',
				"\tcomposes: anything from global;",
				"}",
				".local {}",
			].join("\n"),
		);
		const all = diagnostics(p);
		expect(all.map((d) => [d.code, textAt(p, d)])).toEqual([
			["missingClass", "nope"],
			["missingClass", "buton"],
			["missingClass", "focusabl"],
		]);
		expect(all[1]?.message).toBe("Class 'buton' does not exist in Button.module.css");
		expect(all[0]?.message).toBe("Class 'nope' does not exist in Card.module.css");

		const mono = setup("monorepo").open(
			"apps/web/src/components/Hero.module.css",
			'.hero { composes: surfac from "@repo/ui/shared.module.css"; }',
		);
		expect(diagnostics(mono).map((d) => d.message)).toEqual([
			"Class 'surfac' does not exist in shared.module.css",
		]);
	});

	test("composes from an unresolvable file → missingFile only", () => {
		const p = setup("next-app").open(CARD_CSS, '.card { composes: a b from "./gone.module.css"; }');
		const all = diagnostics(p);
		expect(all.map((d) => [d.code, textAt(p, d)])).toEqual([["missingFile", "./gone.module.css"]]);
		expect(all[0]?.message).toBe("Cannot find stylesheet './gone.module.css'");
	});

	test("@import: missing files flagged, URLs and resolvable specifiers skipped", () => {
		const p = setup("next-app").open(
			"src/app/globals.css",
			[
				'@import "./tokens.css";',
				"@import url(./colors.css);",
				'@import "./gone.css";',
				'@import url("https://example.com/x.css");',
				'@import "@/styles/base.module.css";',
			].join("\n"),
		);
		expect(summary(p)).toEqual([["missingFile", "./gone.css"]]);
	});

	test("@import into node_modules resolves even with nodeModules disabled", () => {
		expect(diagnostics(setup("aliases").open("src/globals.css"))).toEqual([]);
		const p = setup("aliases").open("src/globals.css", '@import "not-installed/style.css";');
		expect(summary(p)).toEqual([["missingFile", "not-installed/style.css"]]);
	});

	test("severity applies to stylesheets", () => {
		const text = '.card { composes: nope; composes: a from "./gone.module.css"; }';
		const p = setup("next-app", severities({ missingClass: "info", missingFile: "off" })).open(
			CARD_CSS,
			text,
		);
		expect(diagnostics(p).map((d) => [d.code, d.severity])).toEqual([
			["missingClass", DiagnosticSeverity.Information],
		]);
	});
});

describe("quick fixes", () => {
	test("did you mean + add rule for a member access", () => {
		const p = setup("next-app").open(BUTTON, 'import styles from "./Button.module.css";\nstyles.buton;');
		const actions = fixes(p);
		expect(actions.map((a) => a.title)).toEqual([
			"Did you mean 'button'?",
			"Add '.buton {}' to Button.module.css",
		]);
		expect(actions.every((a) => a.kind === "quickfix" && a.diagnostics?.length === 1)).toBe(true);
		expect(applied(actions[0], p.file, p.text)).toBe(
			'import styles from "./Button.module.css";\nstyles.button;',
		);
		const css = read("next-app", "src/components/Button.module.css");
		expect(applied(actions[1], BUTTON_CSS, css)).toBe(`${css}\n.buton {\n}\n`);
	});

	test("up to 3 suggestions, closest first", () => {
		const css = ".abcd {}\n.abce {}\n.abcf {}\n.abxx {}\n.zzzz {}\n";
		const { open } = setup("next-app");
		open("src/components/Card.module.css", css);
		const p = open("src/components/Card.tsx", 'import s from "./Card.module.css";\ns.abc;');
		expect(fixes(p).map((a) => a.title)).toEqual([
			"Did you mean 'abcd'?",
			"Did you mean 'abce'?",
			"Did you mean 'abcf'?",
			"Add '.abc {}' to Card.module.css",
		]);
	});

	test("bracket access keeps quotes; non-identifier suggestion switches to brackets", () => {
		const { open } = setup("next-app");
		const quoted = open(BUTTON, "import s from './Button.module.css';\ns['primary-acton'];");
		expect(applied(fixes(quoted)[0], quoted.file, quoted.text)).toBe(
			"import s from './Button.module.css';\ns['primary-action'];",
		);

		const member = open(BUTTON, "import s from './Button.module.css';\ns.primary_action; s?.primary_actio;");
		const actions = fixes(member).filter((a) => a.title === "Did you mean 'primary-action'?");
		expect(actions.map((a) => applied(a, member.file, member.text))).toEqual([
			"import s from './Button.module.css';\ns[\"primary-action\"]; s?.primary_actio;",
			"import s from './Button.module.css';\ns.primary_action; s?.[\"primary-action\"];",
		]);
	});

	test("named imports and requires keep their local names", () => {
		const p = setup("next-app").open(
			"src/components/Card.tsx",
			[
				'import { cad, cad as other } from "./Card.module.css";',
				'const { buton } = require("./Button.module.css");',
				'const { icn: i } = require("./Button.module.css");',
			].join("\n"),
		);
		const results = fixes(p)
			.filter((a) => a.title.startsWith("Did you mean"))
			.map((a) => applied(a, p.file, p.text).split("\n"));
		expect(results.map((lines, i) => lines[[0, 0, 1, 2][i] ?? 0])).toEqual([
			'import { card as cad, cad as other } from "./Card.module.css";',
			'import { cad, card as other } from "./Card.module.css";',
			'const { button: buton } = require("./Button.module.css");',
			'const { icon: i } = require("./Button.module.css");',
		]);
	});

	test("composes names, including across files", () => {
		const { open } = setup("next-app");
		const text = '.card {\n\tcomposes: focusabl from "@/styles/base.module.css";\n}\n';
		const p = open("src/components/Card.module.css", text);
		const actions = fixes(p);
		expect(actions.map((a) => a.title)).toEqual([
			"Did you mean 'focusable'?",
			"Add '.focusabl {}' to base.module.css",
		]);
		expect(applied(actions[0], p.file, p.text)).toBe(text.replace("focusabl", "focusable"));
		const base = fixture("next-app", "src/styles/base.module.css");
		const baseText = read("next-app", "src/styles/base.module.css");
		expect(applied(actions[1], base, baseText)).toBe(`${baseText}\n.focusabl {\n}\n`);

		const local = open("src/components/Card.module.css", ".card { composes: crd; }");
		const [rename, add] = fixes(local);
		expect(applied(rename, local.file, local.text)).toBe(".card { composes: card; }");
		expect(applied(add, local.file, local.text)).toBe(".card { composes: crd; }\n\n.crd {\n}\n");
	});

	test("ignores missingFile and foreign diagnostics", () => {
		const p = setup("aliases").open("src/components/X.tsx");
		expect(fixes(p)).toEqual([]);

		const button = setup("next-app").open(BUTTON);
		const [ours] = diagnostics(button);
		if (!ours) throw new Error("expected a diagnostic");
		const foreign = { ...ours, source: "ts" };
		expect(
			codeActions(button, {
				textDocument: { uri: button.doc.uri },
				range: ours.range,
				context: { diagnostics: [foreign] },
			}),
		).toEqual([]);
	});
});
