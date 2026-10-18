import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInNodeModules, Resolver } from "../src";
import { fixture } from "./helpers";

const resolver = (root: string, pathAlias: Record<string, string> = {}) =>
	new Resolver({ pathAlias, workspaceFolders: [root] });

describe("next-app", () => {
	const root = fixture("next-app");
	const from = fixture("next-app/src/components/Button.tsx");

	test("relative", () => {
		expect(resolver(root).resolve("./Button.module.css", from)).toBe(
			fixture("next-app/src/components/Button.module.css"),
		);
	});

	test("tsconfig paths without baseUrl", () => {
		expect(resolver(root).resolve("@/styles/base.module.css", from)).toBe(
			fixture("next-app/src/styles/base.module.css"),
		);
	});

	test("from a CSS file (composes)", () => {
		const css = fixture("next-app/src/components/Button.module.css");
		expect(resolver(root).resolve("@/styles/base.module.css", css)).toBe(
			fixture("next-app/src/styles/base.module.css"),
		);
	});

	test("missing file and URLs", () => {
		expect(resolver(root).resolve("./nope.module.css", from)).toBeUndefined();
		expect(resolver(root).resolve("https://x.dev/a.css", from)).toBeUndefined();
	});
});

describe("monorepo", () => {
	const root = fixture("monorepo");

	test("each app uses its own @/ alias", () => {
		const r = resolver(root);
		expect(
			r.resolve("@/components/Hero.module.css", fixture("monorepo/apps/web/src/components/Hero.tsx")),
		).toBe(fixture("monorepo/apps/web/src/components/Hero.module.css"));
		expect(r.resolve("@/Page.module.css", fixture("monorepo/apps/docs/app/Page.tsx"))).toBe(
			fixture("monorepo/apps/docs/app/Page.module.css"),
		);
	});

	test("workspace package through exports", () => {
		const resolved = resolver(root).resolve(
			"@repo/ui/shared.module.css",
			fixture("monorepo/apps/web/src/components/Hero.module.css"),
		);
		expect(resolved?.endsWith("packages/ui/src/shared.module.css")).toBe(true);
	});

	test("package root is the nearest package.json", () => {
		expect(resolver(root).packageRoot(fixture("monorepo/apps/web/src/components/Hero.tsx"))).toBe(
			fixture("monorepo/apps/web"),
		);
	});
});

describe("aliases", () => {
	const root = fixture("aliases");
	const from = fixture("aliases/src/components/X.tsx");

	test("tsconfig paths with baseUrl", () => {
		expect(resolver(root).resolve("~styles/a.module.css", from)).toBe(
			fixture("aliases/src/styles/a.module.css"),
		);
	});

	test("package.json imports", () => {
		expect(resolver(root).resolve("#styles/a.module.css", from)).toBe(
			fixture("aliases/src/styles/a.module.css"),
		);
	});

	test("pathAlias setting with ${workspaceFolder} and ${packageRoot}", () => {
		const expected = fixture("aliases/src/theme/theme.module.css");
		expect(
			resolver(root, { "@theme": "${workspaceFolder}/src/theme" }).resolve("@theme/theme.module.css", from),
		).toBe(expected);
		expect(
			resolver(root, { "@theme/*": "${packageRoot}/src/theme/*" }).resolve("@theme/theme.module.css", from),
		).toBe(expected);
		expect(resolver(root, { "@theme": "src/theme" }).resolve("@theme/theme.module.css", from)).toBe(expected);
	});

	test("node_modules package", () => {
		expect(resolver(root).resolve("open-props/style.css", fixture("aliases/src/globals.css"))).toBe(
			fixture("aliases/node_modules/open-props/style.css"),
		);
	});
});

describe("aliasSpecifier", () => {
	test("reverses tsconfig paths", () => {
		const r = resolver(fixture("next-app"));
		expect(
			r.aliasSpecifier(
				fixture("next-app/src/styles/base.module.css"),
				fixture("next-app/src/components/Button.tsx"),
			),
		).toBe("@/styles/base.module.css");
		const a = resolver(fixture("aliases"));
		expect(
			a.aliasSpecifier(fixture("aliases/src/styles/a.module.css"), fixture("aliases/src/components/X.tsx")),
		).toBe("~styles/a.module.css");
		expect(
			a.aliasSpecifier(fixture("aliases/src/globals.css"), fixture("aliases/src/components/X.tsx")),
		).toBe(undefined);
	});
});

describe("alias helpers", () => {
	test("aliasSpecifier follows solution-style references", () => {
		const r = resolver(fixture("monorepo"));
		expect(
			r.aliasSpecifier(
				fixture("monorepo/apps/docs/app/Page.module.css"),
				fixture("monorepo/apps/docs/app/Page.tsx"),
			),
		).toBe("@/Page.module.css");
	});

	test("pathsDirs lists wildcard targets, including ones outside the package", () => {
		const r = resolver(fixture("shared-paths"));
		const from = fixture("shared-paths/apps/site/src/Page.module.css");
		expect(r.pathsDirs(from).sort()).toEqual([
			fixture("shared-paths/apps/site/src"),
			fixture("shared-paths/shared"),
		]);
		expect(r.aliasSpecifier(fixture("shared-paths/shared/ui.module.css"), from)).toBe(
			"@shared/ui.module.css",
		);
	});

	test("pathAliases expands placeholders", () => {
		const root = fixture("aliases");
		const r = resolver(root, { "$styles/*": "${workspaceFolder}/src/styles/*", $pkg: "${packageRoot}/src" });
		expect(r.pathAliases(fixture("aliases/src/components/X.tsx"))).toEqual([
			{ key: "$styles", dir: fixture("aliases/src/styles") },
			{ key: "$pkg", dir: fixture("aliases/src") },
		]);
	});
});

describe("specifier suffixes", () => {
	const root = fixture("next-app");
	const from = fixture("next-app/src/components/Button.tsx");
	const target = fixture("next-app/src/components/Button.module.css");

	test("strips bundler queries and hashes", () => {
		const r = resolver(root);
		expect(r.resolve("./Button.module.css?inline", from)).toBe(target);
		expect(r.resolve("./Button.module.css?url", from)).toBe(target);
		expect(r.resolve("./Button.module.css?raw#x", from)).toBe(target);
		expect(r.resolve("@/components/Button.module.css?inline", from)).toBe(target);
		expect(r.resolve("./nope.module.css?inline", from)).toBeUndefined();
	});

	test("keeps a leading # for package imports", () => {
		const aliases = fixture("aliases");
		expect(
			resolver(aliases).resolve("#styles/a.module.css?raw", fixture("aliases/src/components/X.tsx")),
		).toBe(fixture("aliases/src/styles/a.module.css"));
	});
});

describe("bare specifiers", () => {
	const root = fixture("next-app");

	test("are relative from a stylesheet", () => {
		expect(resolver(root).resolve("components/Button.module.css", fixture("next-app/src/globals.css"))).toBe(
			fixture("next-app/src/components/Button.module.css"),
		);
	});

	test("are packages from a script", () => {
		expect(
			resolver(root).resolve("components/Button.module.css", fixture("next-app/src/page.tsx")),
		).toBeUndefined();
	});
});

describe("normalization", () => {
	class Probe extends Resolver {
		check(file: string) {
			return this.existing(file);
		}
	}

	test("results are platform-normalized", () => {
		const r = new Probe({ pathAlias: {}, workspaceFolders: [fixture("next-app")] });
		expect(r.check(`${fixture("next-app/src")}//components/./Button.module.css`)).toBe(
			fixture("next-app/src/components/Button.module.css"),
		);
		const dep = r.check(`${fixture("aliases")}//node_modules/./open-props/style.css`);
		expect(dep && isInNodeModules(dep)).toBe(true);
	});
});

describe("package root", () => {
	test("stops at the workspace folder below a package.json", () => {
		const r = resolver(fixture("aliases/src"));
		expect(r.packageRoot(fixture("aliases/src/styles/a.module.css"))).toBe(fixture("aliases/src"));
		expect(r.packageRoot(fixture("aliases/src/globals.css"))).toBe(fixture("aliases/src"));
	});

	test("prefers a package.json inside the folder", () => {
		expect(resolver(fixture("aliases")).packageRoot(fixture("aliases/src/styles/a.module.css"))).toBe(
			fixture("aliases"),
		);
	});

	test("outside every workspace folder walks up to the nearest package.json", () => {
		expect(resolver(fixture("next-app")).packageRoot(fixture("aliases/src/styles/a.module.css"))).toBe(
			fixture("aliases"),
		);
	});
});

describe("root-absolute and ~ specifiers", () => {
	test("/x resolves from the package root", () => {
		expect(
			resolver(fixture("next-app")).resolve(
				"/src/styles/base.module.css",
				fixture("next-app/src/components/Button.tsx"),
			),
		).toBe(fixture("next-app/src/styles/base.module.css"));
	});

	test("/x falls back to the workspace folder", () => {
		expect(
			resolver(fixture("monorepo")).resolve(
				"/packages/ui/src/shared.module.css",
				fixture("monorepo/apps/web/src/components/Hero.module.css"),
			),
		).toBe(fixture("monorepo/packages/ui/src/shared.module.css"));
	});

	test("existing absolute paths and misses", () => {
		const from = fixture("next-app/src/components/Button.tsx");
		const target = fixture("next-app/src/styles/base.module.css");
		expect(resolver(fixture("next-app")).resolve(target, from)).toBe(target);
		expect(resolver(fixture("next-app")).resolve("/src/styles/nope.module.css", from)).toBeUndefined();
	});

	test("~pkg resolves as a module (css-loader)", () => {
		const r = resolver(fixture("aliases"));
		expect(r.resolve("~open-props/style.css", fixture("aliases/src/globals.css"))).toBe(
			fixture("aliases/node_modules/open-props/style.css"),
		);
		expect(r.resolve("~/open-props/style.css", fixture("aliases/src/globals.css"))).toBeUndefined();
	});
});

describe("inherited tsconfig paths", () => {
	const r = resolver(fixture("inherited-paths"));
	const from = fixture("inherited-paths/apps/web/src/Page.tsx");
	const target = fixture("inherited-paths/packages/ui/button.module.css");

	test("resolve", () => {
		expect(r.resolve("@ui/button.module.css", from)).toBe(target);
	});

	test("aliasSpecifier and pathsDirs use the declaring config's directory", () => {
		expect(r.aliasSpecifier(target, from)).toBe("@ui/button.module.css");
		expect(r.pathsDirs(from)).toEqual([fixture("inherited-paths/packages/ui")]);
	});
});

test("clear() drops the node resolution stat cache", () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-resolve-")));
	try {
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		const from = path.join(dir, "a.tsx");
		const r = resolver(dir);
		expect(r.resolve("pkg/x.css", from)).toBeUndefined();
		fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
		fs.writeFileSync(path.join(dir, "node_modules", "pkg", "x.css"), "");
		r.clear();
		expect(r.resolve("pkg/x.css", from)).toBe(path.join(dir, "node_modules", "pkg", "x.css"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
