import { describe, expect, test } from "bun:test";
import { defaultSettings, type Settings } from "@css-modules-devtools/core";
import { type Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { globalDiagnostics } from "../src/features/globals";
import { SOURCE, toUri } from "../src/lsp";
import { diagnostics } from "../src/router";
import { fixture, setup } from "./helpers";

const NEXT = { globalFiles: ["src/app/globals.css"] };
const WEB = { globalFiles: ["src/globals.css"] };

const rules = (overrides: Partial<Settings["diagnostics"]>) => ({
	diagnostics: { ...defaultSettings.diagnostics, ...overrides },
});

const byCode = (list: Diagnostic[], code: string) => list.filter((d) => d.code === code);

const related = (d: Diagnostic | undefined) =>
	(d?.relatedInformation ?? []).map((r) => [r.location.uri, r.location.range.start.line]);

describe("varShadowsGlobal", () => {
	test("top-level declaration shadowing a global var", () => {
		const { open } = setup("next-app", NEXT);
		const list = globalDiagnostics(open("src/components/Card.module.css"));
		expect(list).toHaveLength(1);
		const [d] = list;
		expect(d?.code).toBe("varShadowsGlobal");
		expect(d?.source).toBe(SOURCE);
		expect(d?.severity).toBe(DiagnosticSeverity.Warning);
		expect(d?.range).toEqual({ start: { line: 2, character: 1 }, end: { line: 2, character: 5 } });
		expect(d?.message).toContain("--bg");
		expect(d?.message).toContain("globals.css");
		const globals = toUri(fixture("next-app", "src/app/globals.css"));
		expect(related(d)).toEqual([
			[globals, 3],
			[globals, 8],
		]);
	});

	test("vars reached through the global @import graph count", () => {
		const { open } = setup("next-app", NEXT);
		const list = globalDiagnostics(open("src/components/Other.module.css", ".x {\n\t--space-1: 2px;\n}\n"));
		expect(list.map((d) => d.code)).toEqual(["varShadowsGlobal"]);
		expect(related(list[0])).toEqual([[toUri(fixture("next-app", "src/app/tokens.css")), 3]]);
	});

	test("global @import through a tsconfig alias", () => {
		const { open } = setup("globals", WEB);
		const list = byCode(globalDiagnostics(open("src/Widget.module.css")), "varShadowsGlobal");
		expect(list).toHaveLength(1);
		expect(list[0]?.range.start).toEqual({ line: 1, character: 1 });
		expect(related(list[0])).toEqual([[toUri(fixture("globals", "src/theme/vars.css")), 1]]);
	});

	test("monorepo: global files resolve per package root", () => {
		const web = setup("monorepo", WEB).open("apps/web/src/components/Hero.module.css");
		const list = byCode(globalDiagnostics(web), "varShadowsGlobal");
		expect(list).toHaveLength(1);
		expect(list[0]?.range.start.line).toBe(10);
		expect(related(list[0])).toEqual([[toUri(fixture("monorepo", "apps/web/src/globals.css")), 1]]);

		const docs = setup("monorepo", WEB).open(
			"apps/docs/app/Page.module.css",
			".page {\n\t--web-only: 3px;\n}\n",
		);
		expect(globalDiagnostics(docs)).toEqual([]);
	});

	const nested = ".card {\n\t&:hover {\n\t\t--bg: red;\n\t}\n}\n";

	test("maxDepth 0 ignores nested declarations", () => {
		const { open } = setup("next-app", NEXT);
		expect(globalDiagnostics(open("src/components/Nested.module.css", nested))).toEqual([]);
	});

	test("maxDepth 1 and -1 include nested declarations", () => {
		for (const maxDepth of [1, -1]) {
			const { open } = setup("next-app", { ...NEXT, varShadow: { maxDepth } });
			const list = globalDiagnostics(open("src/components/Nested.module.css", nested));
			expect(list.map((d) => d.range.start.line)).toEqual([2]);
		}
		const deeper = ".a {\n\t.b {\n\t\t.c {\n\t\t\t--bg: red;\n\t\t}\n\t}\n}\n";
		expect(
			globalDiagnostics(
				setup("next-app", { ...NEXT, varShadow: { maxDepth: 1 } }).open("src/x.module.css", deeper),
			),
		).toEqual([]);
		expect(
			globalDiagnostics(
				setup("next-app", { ...NEXT, varShadow: { maxDepth: -1 } }).open("src/x.module.css", deeper),
			),
		).toHaveLength(1);
	});

	test("at-rule wrappers and selector complexity don't add depth", () => {
		const { open } = setup("next-app", NEXT);
		const text =
			"@media (min-width: 40rem) {\n\t@supports (display: grid) {\n\t\t.a .b > .c {\n\t\t\t--bg: red;\n\t\t}\n\t}\n}\n";
		expect(globalDiagnostics(open("src/components/Wrapped.module.css", text))).toHaveLength(1);
	});

	test("global files themselves are exempt (theme overrides)", () => {
		const { open } = setup("next-app", NEXT);
		expect(globalDiagnostics(open("src/app/globals.css"))).toEqual([]);
		const override = ":root {\n\t--space-1: 4px;\n}\n[data-theme='dark'] {\n\t--bg: #111;\n}\n";
		expect(globalDiagnostics(open("src/app/colors.css", override))).toEqual([]);
	});

	test("plain .css outside global files is checked", () => {
		const { open } = setup("next-app", NEXT);
		const list = globalDiagnostics(open("src/app/page.css", ":root {\n\t--fg: red;\n}\n"));
		expect(list.map((d) => d.code)).toEqual(["varShadowsGlobal"]);
	});

	test("no global files configured -> nothing", () => {
		const { open } = setup("next-app");
		expect(globalDiagnostics(open("src/components/Card.module.css"))).toEqual([]);
	});
});

describe("globalClassCollision", () => {
	test(":global class vs class in a global file (monorepo)", () => {
		const { open } = setup("monorepo", WEB);
		const list = byCode(
			globalDiagnostics(open("apps/web/src/components/Hero.module.css")),
			"globalClassCollision",
		);
		expect(list).toHaveLength(1);
		const [d] = list;
		expect(d?.severity).toBe(DiagnosticSeverity.Warning);
		expect(d?.source).toBe(SOURCE);
		expect(d?.range).toEqual({ start: { line: 5, character: 9 }, end: { line: 5, character: 22 } });
		expect(d?.message).toContain(".shared-global");
		expect(related(d)).toEqual([[toUri(fixture("monorepo", "apps/web/src/globals.css")), 4]]);
	});

	test("global class reached through an aliased @import", () => {
		const { open } = setup("globals", WEB);
		const text = ":global(.btn) {\n\tcolor: red;\n}\n";
		const list = globalDiagnostics(open("src/Other.module.css", text));
		expect(list.map((d) => d.code)).toEqual(["globalClassCollision"]);
		expect(related(list[0])).toEqual([[toUri(fixture("globals", "src/globals.css")), 2]]);
	});

	test(":global class vs :global of another indexed module", () => {
		const { open } = setup("next-app", NEXT);
		const text = ":global(.legacy) {\n\tcolor: red;\n}\n\n:global .theme-dark .x {\n\tcolor: blue;\n}\n";
		expect(globalDiagnostics(open("src/components/Other.module.css", text))).toEqual([]);

		globalDiagnostics(open("src/components/Button.module.css"));
		const list = globalDiagnostics(open("src/components/Other.module.css", text));
		const button = toUri(fixture("next-app", "src/components/Button.module.css"));
		expect(list.map((d) => [d.code, d.range.start.line])).toEqual([
			["globalClassCollision", 0],
			["globalClassCollision", 4],
		]);
		expect(related(list[0])).toEqual([[button, 28]]);
		expect(related(list[1])).toEqual([[button, 32]]);
	});

	test("monorepo: :global modules of other packages don't collide", () => {
		const { open } = setup("monorepo", WEB);
		globalDiagnostics(open("apps/web/src/components/Hero.module.css"));
		const text = ":global(.shared-global) {\n\tcolor: red;\n}\n";
		expect(globalDiagnostics(open("apps/docs/app/Other.module.css", text))).toEqual([]);
		expect(globalDiagnostics(open("packages/ui/src/Other.module.css", text))).toEqual([]);

		const list = globalDiagnostics(open("apps/web/src/components/Other.module.css", text));
		expect(list.map((d) => d.code)).toEqual(["globalClassCollision"]);
		expect(related(list[0])).toEqual([
			[toUri(fixture("monorepo", "apps/web/src/globals.css")), 4],
			[toUri(fixture("monorepo", "apps/web/src/components/Hero.module.css")), 5],
		]);
	});

	test("local classes and plain .css files are not checked", () => {
		const { open } = setup("monorepo", WEB);
		const local = ".shared-global {\n\tcolor: red;\n}\n";
		expect(globalDiagnostics(open("apps/web/src/components/Local.module.css", local))).toEqual([]);
		expect(globalDiagnostics(open("apps/web/src/other.css", ":global(.shared-global) {}\n"))).toEqual([]);
	});
});

describe("localShadowsGlobal", () => {
	const text = ".container {\n\tcolor: red;\n}\n";

	test("off by default", () => {
		const { open } = setup("next-app", NEXT);
		expect(globalDiagnostics(open("src/components/Layout.module.css", text))).toEqual([]);
	});

	test("reports local classes named like a global class when enabled", () => {
		const { open } = setup("next-app", { ...NEXT, ...rules({ localShadowsGlobal: "hint" }) });
		const list = globalDiagnostics(open("src/components/Layout.module.css", text));
		expect(list).toHaveLength(1);
		const [d] = list;
		expect(d?.code).toBe("localShadowsGlobal");
		expect(d?.severity).toBe(DiagnosticSeverity.Hint);
		expect(d?.range).toEqual({ start: { line: 0, character: 1 }, end: { line: 0, character: 10 } });
		expect(related(d)).toEqual([[toUri(fixture("next-app", "src/app/globals.css")), 11]]);
	});

	test("monorepo + alias fixtures", () => {
		const on = rules({ localShadowsGlobal: "info" });
		const hero = setup("monorepo", { ...WEB, ...on }).open(
			"apps/web/src/components/Hero.module.css",
			".shared-global {}\n",
		);
		expect(globalDiagnostics(hero).map((d) => [d.code, d.severity])).toEqual([
			["localShadowsGlobal", DiagnosticSeverity.Information],
		]);
		const widget = setup("globals", { ...WEB, ...on }).open("src/Widget.module.css");
		expect(byCode(globalDiagnostics(widget), "localShadowsGlobal").map((d) => d.range.start.line)).toEqual([
			4,
		]);
	});
});

test("messages are plain text: diagnostics don't render markdown, so no backticks", () => {
	const on = rules({ localShadowsGlobal: "hint" });
	const list = [
		...globalDiagnostics(setup("next-app", NEXT).open("src/components/Card.module.css")),
		...globalDiagnostics(setup("monorepo", WEB).open("apps/web/src/components/Hero.module.css")),
		...globalDiagnostics(
			setup("next-app", { ...NEXT, ...on }).open("src/components/Layout.module.css", ".container {}\n"),
		),
	];
	expect(new Set(list.map((d) => d.code))).toEqual(
		new Set(["varShadowsGlobal", "globalClassCollision", "localShadowsGlobal"]),
	);
	for (const d of list) {
		expect(d.message).not.toContain("`");
		for (const r of d.relatedInformation ?? []) expect(r.message).not.toContain("`");
	}
	expect(list[0]?.message).toBe("'--bg' shadows a global variable declared in globals.css.");
});

describe("severities", () => {
	test("each rule follows its configured severity", () => {
		const { open } = setup("monorepo", {
			...WEB,
			...rules({ varShadowsGlobal: "error", globalClassCollision: "info" }),
		});
		const list = globalDiagnostics(open("apps/web/src/components/Hero.module.css"));
		expect(list.map((d) => [d.code, d.severity])).toEqual([
			["varShadowsGlobal", DiagnosticSeverity.Error],
			["globalClassCollision", DiagnosticSeverity.Information],
		]);
	});

	test("off rules are skipped", () => {
		const off = rules({ varShadowsGlobal: "off", globalClassCollision: "off" });
		const { open } = setup("monorepo", { ...WEB, ...off });
		expect(globalDiagnostics(open("apps/web/src/components/Hero.module.css"))).toEqual([]);

		const shadowOnly = setup("monorepo", { ...WEB, ...rules({ globalClassCollision: "off" }) });
		const list = globalDiagnostics(shadowOnly.open("apps/web/src/components/Hero.module.css"));
		expect(list.map((d) => d.code)).toEqual(["varShadowsGlobal"]);
	});

	test("router includes global diagnostics for CSS files only", () => {
		const next = setup("next-app", NEXT);
		expect(byCode(diagnostics(next.open("src/components/Card.module.css")), "varShadowsGlobal")).toHaveLength(
			1,
		);
		const quiet = setup("next-app", { ...NEXT, ...rules({ varShadowsGlobal: "off" }) });
		expect(byCode(diagnostics(quiet.open("src/components/Card.module.css")), "varShadowsGlobal")).toEqual([]);
		const script = next.open("src/components/Card.tsx");
		const ours = ["varShadowsGlobal", "globalClassCollision", "localShadowsGlobal"];
		expect(diagnostics(script).filter((d) => ours.includes(String(d.code)))).toEqual([]);
	});
});
