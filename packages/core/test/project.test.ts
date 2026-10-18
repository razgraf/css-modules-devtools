import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composedSources, Project } from "../src";
import { fixture, project } from "./helpers";

describe("import graph", () => {
	test("follows @import recursively and stops on cycles", () => {
		const p = project(fixture("next-app"));
		expect(p.importGraph(fixture("next-app/src/app/globals.css"))).toEqual([
			fixture("next-app/src/app/globals.css"),
			fixture("next-app/src/app/tokens.css"),
			fixture("next-app/src/app/colors.css"),
		]);
	});

	test("skips node_modules unless enabled", () => {
		const off = project(fixture("aliases"));
		expect(off.importGraph(fixture("aliases/src/globals.css"))).toHaveLength(1);
		const on = project(fixture("aliases"), { nodeModules: { enabled: true } });
		expect(on.importGraph(fixture("aliases/src/globals.css"))).toContain(
			fixture("aliases/node_modules/open-props/style.css"),
		);
	});
});

describe("global scope", () => {
	test("globalFiles resolve per package root and include their imports", () => {
		const p = project(fixture("next-app"), { globalFiles: ["src/app/globals.css"] });
		const scope = p.globalScope(fixture("next-app/src/components/Button.module.css"));
		expect(scope.files).toHaveLength(3);
		expect([...scope.vars.keys()]).toEqual(
			expect.arrayContaining(["--bg", "--fg", "--space-1", "--brand", "--gray-900"]),
		);
		expect(scope.classes.has("container")).toBe(true);
	});

	test("${workspaceFolder}/ patterns resolve from the workspace folder", () => {
		const p = project(fixture("monorepo"), { globalFiles: ["${workspaceFolder}/apps/web/src/globals.css"] });
		const scope = p.globalScope(fixture("monorepo/apps/docs/app/Page.module.css"));
		expect(scope.vars.has("--web-only")).toBe(true);
	});

	test("monorepo packages don't see each other's globals", () => {
		const p = project(fixture("monorepo"), { globalFiles: ["src/globals.css"] });
		expect(
			p.globalScope(fixture("monorepo/apps/web/src/components/Hero.module.css")).vars.has("--web-only"),
		).toBe(true);
		expect(p.globalScope(fixture("monorepo/apps/docs/app/Page.module.css")).vars.size).toBe(0);
	});

	test("globs stay inside a workspace folder that sits below the package.json", () => {
		const p = project(fixture("aliases/src"), { globalFiles: ["**/*.css"], nodeModules: { enabled: true } });
		const files = p.globalFiles(fixture("aliases/src/styles/a.module.css"));
		expect(files).toContain(fixture("aliases/src/globals.css"));
		expect(files.every((f) => f.startsWith(`${fixture("aliases/src")}${path.sep}`))).toBe(true);
	});

	test("node_modules globs only when enabled", () => {
		const glob = ["node_modules/open-props/style.css"];
		const file = fixture("aliases/src/styles/a.module.css");
		expect(project(fixture("aliases"), { globalFiles: glob }).globalScope(file).vars.size).toBe(0);
		expect(
			project(fixture("aliases"), { globalFiles: glob, nodeModules: { enabled: true } })
				.globalScope(file)
				.vars.has("--op-blue"),
		).toBe(true);
	});
});

describe("known vars", () => {
	test("css file sees own, imported and global vars", () => {
		const p = project(fixture("next-app"), { globalFiles: ["src/app/globals.css"] });
		const vars = p.knownVars(fixture("next-app/src/components/Card.module.css"));
		expect(vars.has("--bg")).toBe(true);
		expect(vars.get("--bg")?.length).toBe(3);
		expect(vars.has("--brand")).toBe(true);
	});

	test("script sees vars of imported modules and globals", () => {
		const p = project(fixture("next-app"), { globalFiles: ["src/app/globals.css"] });
		const vars = p.knownVarsForScript(fixture("next-app/src/components/Button.tsx"));
		expect(vars.has("--brand")).toBe(true);
		expect(vars.has("--container")).toBe(false);
		expect(vars.has("--bg")).toBe(true);
	});
});

describe("cache", () => {
	test("invalidate re-reads overlay content", () => {
		const files = new Map([["/v/a.module.css", ".a {}"]]);
		const p = new Project({ read: (f) => files.get(f) });
		expect(p.cssInfo("/v/a.module.css")?.classes.has("a")).toBe(true);
		files.set("/v/a.module.css", ".b {}");
		expect(p.cssInfo("/v/a.module.css")?.classes.has("b")).toBe(false);
		p.invalidate("/v/a.module.css");
		expect(p.cssInfo("/v/a.module.css")?.classes.has("b")).toBe(true);
	});

	test("tsxInfo keeps the last good analysis when text stops parsing", () => {
		const files = new Map<string, string>();
		const p = new Project({ read: (f) => files.get(f) });
		const good = 'import s from "./a.module.css";\ns.a;';
		expect(p.tsxInfo("/v/a.tsx", good)?.bindings).toHaveLength(1);
		p.invalidate("/v/a.tsx");
		const broken = `${good}\nconst = = ;{{{`;
		expect(p.tsxInfo("/v/a.tsx", broken)?.bindings).toHaveLength(1);
		expect(p.parsedTsxInfo("/v/a.tsx", broken)).toBeUndefined();
		expect(p.parsedTsxInfo("/v/a.tsx", good)?.bindings).toHaveLength(1);
	});
});

describe("invalidation granularity", () => {
	const globals = { globalFiles: ["src/app/globals.css"] };
	const module = fixture("next-app/src/components/Button.module.css");

	test("editing a script or a non-global stylesheet keeps the global scope", () => {
		const p = project(fixture("next-app"), globals);
		const scope = p.globalScope(module);
		p.invalidate(fixture("next-app/src/components/Button.tsx"));
		expect(p.globalScope(module)).toBe(scope);
		p.invalidate(module);
		expect(p.globalScope(module)).toBe(scope);
	});

	test("editing a global stylesheet (or one it imports) drops the scope", () => {
		const p = project(fixture("next-app"), globals);
		const scope = p.globalScope(module);
		p.invalidate(fixture("next-app/src/app/colors.css"));
		const next = p.globalScope(module);
		expect(next).not.toBe(scope);
		p.invalidate(fixture("next-app/src/app/globals.css"));
		expect(p.globalScope(module)).not.toBe(next);
	});

	test("filesChanged(paths) drops only those stylesheets", () => {
		const p = project(fixture("next-app"));
		const card = fixture("next-app/src/components/Card.module.css");
		const base = fixture("next-app/src/styles/base.module.css");
		const [a, b, c] = [p.cssInfo(module), p.cssInfo(card), p.cssInfo(base)];
		p.filesChanged([module]);
		expect(p.cssInfo(card)).toBe(b);
		expect(p.cssInfo(module)).not.toBe(a);
		p.filesChanged([fixture("next-app/src/styles")]);
		expect(p.cssInfo(card)).toBe(b);
		expect(p.cssInfo(base)).not.toBe(c);
		p.filesChanged();
		expect(p.cssInfo(card)).not.toBe(b);
	});

	test("var maps are memoized and follow edits", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-project-")));
		try {
			const css = path.join(dir, "a.module.css");
			const imported = path.join(dir, "b.css");
			const script = path.join(dir, "a.tsx");
			fs.writeFileSync(css, '@import "./b.css";\n.a { --x: 1; }');
			fs.writeFileSync(imported, ":root { --y: 1; }");
			fs.writeFileSync(script, 'import s from "./a.module.css";\ns.a;');
			const p = new Project();

			const vars = p.knownVars(css);
			expect(p.knownVars(css)).toBe(vars);
			expect([...vars.keys()].sort()).toEqual(["--x", "--y"]);
			const scriptVars = p.knownVarsForScript(script);
			expect(p.knownVarsForScript(script)).toBe(scriptVars);
			expect(scriptVars.has("--y")).toBe(true);

			fs.writeFileSync(imported, ":root { --z: 1; }");
			p.invalidate(imported);
			expect([...p.knownVars(css).keys()].sort()).toEqual(["--x", "--z"]);
			expect(p.knownVarsForScript(script).has("--z")).toBe(true);

			fs.writeFileSync(script, "export {};");
			p.invalidate(script);
			expect(p.knownVarsForScript(script).size).toBe(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("module files", () => {
	test("cached per root until filesChanged", () => {
		const p = project(fixture("auto-import"));
		const files = p.moduleFiles(fixture("auto-import"));
		expect(files).toContain(fixture("auto-import/src/root.module.css"));
		expect(p.moduleFiles(fixture("auto-import"), fixture("auto-import/src/many/x.tsx"))).toBe(files);
		p.filesChanged([fixture("auto-import/src/new.module.css")]);
		expect(p.moduleFiles(fixture("auto-import"))).not.toBe(files);
	});
});

describe("composes", () => {
	test("resolves across files recursively in application order", () => {
		const p = project(fixture("next-app"));
		const sources = composedSources(p, fixture("next-app/src/components/Card.module.css"), "card");
		expect(sources.map((s) => [s.className, s.depth])).toEqual([
			["reset", 3],
			["focusable", 2],
			["button", 1],
		]);
		expect(sources[2]?.rules.length).toBe(4);
	});

	test("is cycle-safe", () => {
		const files = new Map([["/v/a.module.css", ".a { composes: b; } .b { composes: a; }"]]);
		const p = new Project({ read: (f) => files.get(f) });
		expect(composedSources(p, "/v/a.module.css", "a").map((s) => s.className)).toEqual(["b"]);
	});
});

test("indexedFiles lists parsed stylesheets only", () => {
	const p = project(fixture("next-app"));
	expect(p.indexedFiles()).toEqual([]);
	p.cssInfo(fixture("next-app/src/styles/base.module.css"));
	expect(p.indexedFiles()).toEqual([fixture("next-app/src/styles/base.module.css")]);
});
