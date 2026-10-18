import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type ImportSpecifierPreference,
	type ScriptContext,
	scriptContext,
} from "@css-modules-devtools/core";
import { defaultSettings } from "@css-modules-devtools/core/types";
import type { CompletionItem, TextEdit } from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { DocParams } from "../src/context";
import { autoImportCompletions } from "../src/features/autoImport";
import { completion } from "../src/router";
import { FIXTURES, fixture, setup } from "./helpers";

type Member = Extract<ScriptContext, { kind: "member" }>;

function member(p: DocParams): Member {
	const c = scriptContext(p.text, p.offset);
	if (c?.kind !== "member") throw new Error("expected a member context");
	return c;
}

function complete(
	root: string,
	file: string,
	text: string,
	preference?: ImportSpecifierPreference,
	identifiers = defaultSettings.autoImport.identifiers,
) {
	const autoImport = { enabled: true, importModuleSpecifier: preference ?? "shortest", identifiers };
	const p = setup(root, { autoImport }).open(file, text);
	return { p, items: autoImportCompletions(p, member(p)) };
}

/** Document text after applying the item's main edit and its import edit. */
function accept(p: DocParams, item: CompletionItem): string {
	const edits: TextEdit[] = [...(item.additionalTextEdits ?? [])];
	if (item.textEdit && "range" in item.textEdit) edits.push(item.textEdit);
	return TextDocument.applyEdits(p.doc, edits);
}

const sources = (items: CompletionItem[]) => [...new Set(items.map((i) => i.labelDetails?.description))];

const NEW_THING = `import { useState } from "react";

export function NewThing() {
	return <div className={styles.|} />;
}
`;

describe("autoImportCompletions", () => {
	test("offers exported keys of nearby modules with an import edit", () => {
		const { p, items } = complete("next-app", "src/components/NewThing.tsx", NEW_THING);
		const button = items.find((i) => i.label === "button");
		expect(button?.detail).toBe("Auto import from ./Button.module.css");
		expect(button?.labelDetails?.description).toBe("./Button.module.css");
		expect(button && accept(p, button)).toBe(`import { useState } from "react";
import styles from "./Button.module.css";

export function NewThing() {
	return <div className={styles.button} />;
}
`);
		expect(items.some((i) => i.label === "legacy" || i.label === "spin")).toBe(false);
	});

	test("kebab keys insert bracket access from the dot", () => {
		const { p, items } = complete("next-app", "src/components/NewThing.tsx", NEW_THING);
		const kebab = items.find((i) => i.label === "primary-action");
		expect(kebab?.filterText).toBe(".primary-action");
		expect(kebab && accept(p, kebab)).toContain(`className={styles["primary-action"]}`);
	});

	test("all items share one range start, so the client ranks them by sortText (sibling first)", () => {
		const { items } = complete("next-app", "src/components/Card.tsx", "const x = css.|\n");
		const starts = new Set(
			items.map((i) => (i.textEdit && "range" in i.textEdit ? JSON.stringify(i.textEdit.range.start) : "")),
		);
		expect(starts.size).toBe(1);
		expect(items.every((i) => i.filterText === `.${i.label}`)).toBe(true);
	});

	test("optional chaining keeps `?.`", () => {
		const text = "const x = styles?.|;\n";
		const { p, items } = complete("next-app", "src/components/NewThing.tsx", text);
		const kebab = items.find((i) => i.label === "primary-action");
		expect(kebab && accept(p, kebab)).toBe(
			`import styles from "./Button.module.css";\nconst x = styles?.["primary-action"];\n`,
		);
	});

	test("follows the classNameConvention setting", () => {
		const p = setup("next-app", { classNameConvention: "camelCaseOnly" }).open(
			"src/components/NewThing.tsx",
			NEW_THING,
		);
		const labels = autoImportCompletions(p, member(p)).map((i) => i.label);
		expect(labels).toContain("primaryAction");
		expect(labels).not.toContain("primary-action");
	});

	test("ranks the same-basename sibling first", () => {
		const { items } = complete("next-app", "src/components/Card.tsx", "const x = css.|\n");
		expect(sources(items)).toEqual(["./Card.module.css", "./Button.module.css", "@/styles/base.module.css"]);
		const card = items.find((i) => i.label === "card");
		const button = items.find((i) => i.label === "button");
		expect((card?.sortText ?? "") < (button?.sortText ?? "")).toBe(true);
	});

	test("ranks sibling → same dir → ancestors → rest, capped at 10 files", () => {
		const { items } = complete(
			"auto-import",
			"src/features/profile/Profile.tsx",
			"const x = s.|\n",
			"relative",
		);
		expect(sources(items)).toEqual([
			"./Profile.module.css",
			"./Avatar.module.css",
			"../feature.module.css",
			"../../root.module.css",
			"../settings/Settings.module.css",
			"../../many/m01.module.css",
			"../../many/m02.module.css",
			"../../many/m03.module.css",
			"../../many/m04.module.css",
			"../../many/m05.module.css",
		]);
	});

	test("skips node_modules, dot-dirs and nested packages", () => {
		expect(fs.existsSync(fixture("auto-import", "src/.hidden/hidden.module.css"))).toBe(true);
		const { items } = complete("auto-import", "src/Thing.tsx", "const x = s.|\n");
		const labels = items.map((i) => i.label);
		expect(labels).toContain("root");
		expect(labels).not.toContain("dep");
		expect(labels).not.toContain("hidden");
		expect(labels).not.toContain("vendored");
	});

	describe("specifier styles", () => {
		const cases: [ImportSpecifierPreference, string][] = [
			["shortest", "@/styles/base.module.css"],
			["non-relative", "@/styles/base.module.css"],
			["relative", "../styles/base.module.css"],
			["project-relative", "../styles/base.module.css"],
		];
		for (const [preference, expected] of cases) {
			test(preference, () => {
				const { items } = complete("next-app", "src/components/NewThing.tsx", NEW_THING, preference);
				expect(items.find((i) => i.label === "reset")?.labelDetails?.description).toBe(expected);
			});
		}

		test("shortest prefers relative when the alias isn't shorter", () => {
			const { items } = complete("next-app", "src/components/NewThing.tsx", NEW_THING, "shortest");
			expect(items.find((i) => i.label === "button")?.labelDetails?.description).toBe("./Button.module.css");
		});

		test("non-relative falls back to relative without paths", () => {
			const { items } = complete("auto-import", "src/Thing.tsx", "const x = s.|\n", "non-relative");
			expect(sources(items)).toContain("~/features/feature.module.css");
			const { items: plain } = complete(
				"monorepo",
				"packages/ui/src/X.tsx",
				"const x = s.|\n",
				"non-relative",
			);
			expect(sources(plain)).toEqual(["./shared.module.css"]);
		});

		test("baseUrl paths alias", () => {
			const { items } = complete("auto-import", "src/features/profile/Profile.tsx", "s.|", "non-relative");
			expect(sources(items)[0]).toBe("~/features/profile/Profile.module.css");
		});
	});

	test("monorepo: stays inside the app's package", () => {
		const { items } = complete(
			"monorepo",
			"apps/web/src/app/New.tsx",
			"const x = styles.|\n",
			"non-relative",
		);
		expect(sources(items)).toEqual(["@/components/Hero.module.css"]);
		expect(items.map((i) => i.label)).not.toContain("page");
		expect(items.map((i) => i.label)).not.toContain("surface");
	});

	test("monorepo: docs app never sees web modules", () => {
		const { items } = complete("monorepo", "apps/docs/app/New.tsx", "const x = styles.|\n");
		expect(sources(items)).toEqual(["./Page.module.css"]);
	});

	describe("import placement and style", () => {
		const accepted = (text: string) => {
			const { p, items } = complete("next-app", "src/components/NewThing.tsx", text);
			const button = items.find((i) => i.label === "button");
			if (!button) throw new Error("no button item");
			return accept(p, button);
		};

		test("file top when there are no imports", () => {
			expect(accepted("const x = styles.|;\n")).toBe(
				`import styles from "./Button.module.css";\nconst x = styles.button;\n`,
			);
		});

		test("after directives", () => {
			expect(accepted(`"use client";\n\nconst x = styles.|;\n`)).toBe(
				`"use client";\nimport styles from "./Button.module.css";\n\nconst x = styles.button;\n`,
			);
		});

		test("after the last (multi-line) import, keeping trailing comments", () => {
			const text = `import a from "a"; // first\nimport {\n\tb,\n} from "b";\n\nconst x = styles.|;\n`;
			expect(accepted(text)).toBe(
				`import a from "a"; // first\nimport {\n\tb,\n} from "b";\nimport styles from "./Button.module.css";\n\nconst x = styles.button;\n`,
			);
		});

		test("single quotes and no semicolons", () => {
			expect(accepted(`import a from 'a'\n\nconst x = styles.|\n`)).toBe(
				`import a from 'a'\nimport styles from './Button.module.css'\n\nconst x = styles.button\n`,
			);
		});

		test("uses the typed identifier", () => {
			expect(accepted("const x = css.|;\n")).toStartWith(`import css from "./Button.module.css";\n`);
		});
	});

	describe("only for unbound identifiers", () => {
		const none = (text: string) => complete("next-app", "src/components/NewThing.tsx", text).items;

		test("bound CSS module import", () => {
			expect(none(`import styles from "./Button.module.css";\nconst x = styles.|;\n`)).toEqual([]);
		});

		test("local declarations, params and destructuring", () => {
			expect(none("const styles = { a: 1 };\nstyles.|")).toEqual([]);
			expect(none("function f(styles) { return styles.| }")).toEqual([]);
			expect(none("const f = ({ styles }) => styles.|")).toEqual([]);
			expect(none("import { styles } from './theme';\nstyles.|")).toEqual([]);
			expect(none("class styles {}\nstyles.|")).toEqual([]);
		});

		test("property chains", () => {
			expect(none("props.styles.|")).toEqual([]);
			expect(none("const o = { ...styles.| }")).not.toEqual([]);
		});

		test("unbound names a local declaration shadows still count as bound", () => {
			expect(none("const s = 1;\ns.|")).toEqual([]);
		});

		test("other unbound usages and property names don't count as declarations", () => {
			expect(none("const a = styles.button;\nconst o = { x: obj.styles };\nstyles.|")).not.toEqual([]);
		});
	});
});

describe("identifier allow-list", () => {
	const items = (text: string, identifiers?: string[]) =>
		complete("next-app", "src/components/NewThing.tsx", text, "shortest", identifiers).items;

	test("default identifiers trigger", () => {
		for (const name of ["styles", "classes", "css", "s"]) {
			expect(items(`const x = ${name}.|;\n`).length).toBeGreaterThan(0);
		}
	});

	test("unbound names outside the list never trigger", () => {
		expect(items("expect.|")).toEqual([]);
		expect(items("Buffer.|")).toEqual([]);
		expect(items("console.|")).toEqual([]);
		expect(items("const el = <Foo.| />;\n")).toEqual([]);
		expect(items("const x = theme.|;\n")).toEqual([]);
	});

	test("custom list replaces the defaults", () => {
		expect(items("const x = theme.|;\n", ["theme"]).length).toBeGreaterThan(0);
		expect(items("const x = styles.|;\n", ["theme"])).toEqual([]);
	});

	test("empty list disables auto-import", () => {
		expect(items("const x = styles.|;\n", [])).toEqual([]);
	});
});

describe("comments", () => {
	// Through the router: the core scanner rejects comment positions before auto-import runs.
	const items = (text: string) => completion(setup("next-app").open("src/components/NewThing.tsx", text));

	test("line and block comments", () => {
		expect(items("// styles.|")).toEqual([]);
		expect(items("const a = 1; // see styles.|")).toEqual([]);
		expect(items("/* styles.| */")).toEqual([]);
		expect(items("/**\n * Uses styles.|\n */\nconst x = 1;\n")).toEqual([]);
		expect(items("/* unterminated styles.|")).toEqual([]);
		expect(items("<div>{/* styles.| */}</div>")).toEqual([]);
	});

	test("code after a closed comment still triggers", () => {
		expect(items("/* note */ const x = styles.|;\n").length).toBeGreaterThan(0);
		expect(items("// note\nconst x = styles.|;\n").length).toBeGreaterThan(0);
	});

	test("comment markers inside strings, templates and regexes don't count", () => {
		expect(items(`const u = "http://x"; const x = styles.|;\n`).length).toBeGreaterThan(0);
		expect(items(`const u = '/*'; const x = styles.|;\n`).length).toBeGreaterThan(0);
		expect(items("const t = `a // ${b} /*`; const x = styles.|;\n").length).toBeGreaterThan(0);
		expect(items("const t = `${`/*`}`; const x = styles.|;\n").length).toBeGreaterThan(0);
		expect(items("const r = /\\/*/; const x = styles.|;\n").length).toBeGreaterThan(0);
		expect(items("const t = `${styles.|}`;\n").length).toBeGreaterThan(0);
	});

	test("an apostrophe in JSX text doesn't hide later comments or code", () => {
		expect(items("const a = <p>Don't</p>;\n// styles.|")).toEqual([]);
		expect(items("const a = <p>Don't</p>;\nconst x = styles.|;\n").length).toBeGreaterThan(0);
	});

	test("a URL in JSX text is not a comment", () => {
		expect(items("const a = <a>see https://x.dev</a>; const x = styles.|;\n").length).toBeGreaterThan(0);
	});
});

describe("router.completion", () => {
	const text = `import { useState } from "react";\nconst x = styles.|;\n`;

	test("routes unbound members to auto-import", () => {
		const p = setup("next-app").open("src/components/NewThing.tsx", text);
		expect(completion(p).some((i) => i.additionalTextEdits?.length)).toBe(true);
	});

	test("autoImport.enabled=false", () => {
		const autoImport = { ...defaultSettings.autoImport, enabled: false };
		const p = setup("next-app", { autoImport }).open("src/components/NewThing.tsx", text);
		expect(completion(p)).toEqual([]);
	});

	test("completion.enabled=false", () => {
		const p = setup("next-app", { completion: { enabled: false } }).open("src/components/NewThing.tsx", text);
		expect(completion(p)).toEqual([]);
	});

	test("bound identifier goes through class completion, never auto-import", () => {
		const bound = `import styles from "./Button.module.css";\nconst x = styles.|;\n`;
		const p = setup("next-app").open("src/components/NewThing.tsx", bound);
		expect(completion(p).some((i) => i.additionalTextEdits?.length)).toBe(false);
	});
});

describe("module discovery", () => {
	test("a module created after a completion is offered once the project hears about it", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmdt-auto-")));
		try {
			fs.writeFileSync(path.join(dir, "package.json"), "{}");
			fs.mkdirSync(path.join(dir, "src"));
			fs.writeFileSync(path.join(dir, "src/a.module.css"), ".alpha {}\n");
			const { ctx, open } = setup(path.relative(FIXTURES, dir));
			const labels = () => {
				const p = open("src/App.tsx", "const x = styles.|\n");
				return autoImportCompletions(p, member(p)).map((i) => i.label);
			};
			expect(labels()).toEqual(["alpha"]);

			const created = path.join(dir, "src/b.module.css");
			fs.writeFileSync(created, ".beta {}\n");
			ctx.project.filesChanged([created]);
			expect(labels().sort()).toEqual(["alpha", "beta"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
