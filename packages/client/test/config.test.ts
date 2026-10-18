import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@css-modules-devtools/core/types";
import { buildConfiguration, CMK_EXTENSION, type Setting, setting } from "../src/config";

type Values = Record<string, unknown>;

/** `defaults` mimic contributed defaults (never user-set); `user` values count as explicitly set. */
function reader(user: Values = {}, defaults: Values = {}) {
	return (section: string, key: string): Setting => {
		const id = `${section}.${key}`;
		if (id in user) return { value: user[id], userSet: true };
		return { value: defaults[id], userSet: false };
	};
}

const none = () => false;
const build = (user?: Values, defaults?: Values) => buildConfiguration(reader(user, defaults), none);

describe("buildConfiguration", () => {
	test("defaults when nothing is set", () => {
		expect(build()).toEqual({ settings: defaultSettings, env: { cmkExtension: false, useTsgo: false } });
	});

	test("merges our settings over defaults", () => {
		const { settings } = build({
			"cssModulesDevTools.tsx.enabled": "off",
			"cssModulesDevTools.hover.maxLines": 5,
			"cssModulesDevTools.variables.colors": false,
			"cssModulesDevTools.classNameConvention": "camelCaseOnly",
			"cssModulesDevTools.varShadow.maxDepth": -1,
			"cssModulesDevTools.nodeModules.enabled": true,
			"cssModulesDevTools.diagnostics": { missingClass: "warning" },
		});
		expect(settings.tsx.enabled).toBe("off");
		expect(settings.hover).toEqual({ enabled: true, maxLines: 5 });
		expect(settings.variables).toEqual({ enabled: true, tsxStrings: true, colors: false });
		expect(settings.classNameConvention).toBe("camelCaseOnly");
		expect(settings.varShadow.maxDepth).toBe(-1);
		expect(settings.nodeModules.enabled).toBe(true);
		expect(settings.diagnostics).toEqual({ ...defaultSettings.diagnostics, missingClass: "warning" });
	});

	test("does not share mutable defaults", () => {
		const first = build().settings;
		first.pathAlias.x = "y";
		first.globalFiles.push("a.css");
		first.diagnostics.missingClass = "off";
		first.autoImport.identifiers.push("x");
		expect(build().settings).toEqual(defaultSettings);
	});

	test("rejects invalid enums and types", () => {
		const { settings } = build({
			"cssModulesDevTools.tsx.enabled": "sometimes",
			"cssModulesDevTools.completion.enabled": "yes",
			"cssModulesDevTools.hover.maxLines": 0,
			"cssModulesDevTools.classNameConvention": "kebab",
			"cssModulesDevTools.varShadow.maxDepth": 1.5,
			"cssModulesDevTools.pathAlias": { "@a": "/a", "@b": 3 },
			"cssModulesDevTools.globalFiles": ["a.css", 2, ""],
			"cssModulesDevTools.diagnostics": { missingClass: "fatal", missingFile: "hint", unknown: "error" },
			"typescript.preferences.importModuleSpecifier": "absolute",
		});
		expect(settings.tsx.enabled).toBe("auto");
		expect(settings.completion.enabled).toBe(true);
		expect(settings.hover.maxLines).toBe(30);
		expect(settings.classNameConvention).toBe("asIs");
		expect(settings.varShadow.maxDepth).toBe(0);
		expect(settings.pathAlias).toEqual({ "@a": "/a" });
		expect(settings.globalFiles).toEqual(["a.css"]);
		expect(settings.diagnostics).toEqual({ ...defaultSettings.diagnostics, missingFile: "hint" });
		expect(settings.autoImport.importModuleSpecifier).toBe("shortest");
	});

	test("rejects a non-object diagnostics value", () => {
		expect(build({ "cssModulesDevTools.diagnostics": "error" }).settings.diagnostics).toEqual(
			defaultSettings.diagnostics,
		);
	});
});

describe("pathAlias fallback", () => {
	const legacy = { "cssModules.pathAlias": { "@styles": "${workspaceFolder}/src/styles" } };

	test("uses cssModules.pathAlias when ours is not set", () => {
		const { settings } = build(legacy, { "cssModulesDevTools.pathAlias": {} });
		expect(settings.pathAlias).toEqual({ "@styles": "${workspaceFolder}/src/styles" });
	});

	test("ours wins when set, even if empty", () => {
		expect(build({ ...legacy, "cssModulesDevTools.pathAlias": { "~": "/x" } }).settings.pathAlias).toEqual({
			"~": "/x",
		});
		expect(build({ ...legacy, "cssModulesDevTools.pathAlias": {} }).settings.pathAlias).toEqual({});
	});
});

describe("globalFiles fallback", () => {
	const lookupDefaults = { "cssVariables.lookupFiles": ["**/*.less", "**/*.scss", "**/*.sass", "**/*.css"] };

	test("ignores cssVariables.lookupFiles defaults", () => {
		expect(build({}, lookupDefaults).settings.globalFiles).toEqual([]);
	});

	test("uses cssVariables.lookupFiles only when user-set", () => {
		const { settings } = build({ "cssVariables.lookupFiles": ["src/app/globals.css"] }, lookupDefaults);
		expect(settings.globalFiles).toEqual(["src/app/globals.css"]);
	});

	test("ours wins when set", () => {
		const { settings } = build({
			"cssVariables.lookupFiles": ["src/app/globals.css"],
			"cssModulesDevTools.globalFiles": ["src/tokens.css"],
		});
		expect(settings.globalFiles).toEqual(["src/tokens.css"]);
	});
});

describe("autoImport.identifiers", () => {
	const identifiers = (value: unknown) =>
		build({ "cssModulesDevTools.autoImport.identifiers": value }).settings.autoImport.identifiers;

	test("defaults to styles, classes, css, s", () => {
		expect(build().settings.autoImport.identifiers).toEqual(["styles", "classes", "css", "s"]);
	});

	test("uses the configured list", () => {
		expect(identifiers(["theme", "$sx", "_c"])).toEqual(["theme", "$sx", "_c"]);
	});

	test("drops non-identifiers and duplicates", () => {
		expect(identifiers(["ok", "", "1a", "a-b", "a.b", 3, null, "ok"])).toEqual(["ok"]);
	});

	test("keeps an explicit empty list", () => {
		expect(identifiers([])).toEqual([]);
	});

	test("falls back to defaults for a non-array", () => {
		expect(identifiers("styles")).toEqual(defaultSettings.autoImport.identifiers);
	});
});

describe("TypeScript preferences", () => {
	test("importModuleSpecifier follows typescript.preferences", () => {
		for (const style of ["shortest", "relative", "non-relative", "project-relative"] as const) {
			const { settings } = build({ "typescript.preferences.importModuleSpecifier": style });
			expect(settings.autoImport.importModuleSpecifier).toBe(style);
		}
	});

	test("defaults to shortest", () => {
		expect(build().settings.autoImport.importModuleSpecifier).toBe("shortest");
	});
});

describe("environment", () => {
	test("detects the css-modules-kit extension", () => {
		const { env } = buildConfiguration(reader(), (id) => id === CMK_EXTENSION);
		expect(env.cmkExtension).toBe(true);
	});

	test("useTsgo only when exactly true", () => {
		expect(build({ "typescript.experimental.useTsgo": true }).env.useTsgo).toBe(true);
		expect(build({ "typescript.experimental.useTsgo": "true" }).env.useTsgo).toBe(false);
		expect(build({ "typescript.experimental.useTsgo": false }).env.useTsgo).toBe(false);
	});
});

describe("setting", () => {
	const workspace = { defaultValue: {}, globalValue: { "@a": "/user" }, workspaceValue: { "@a": "/etc" } };

	test("counts any explicit level as user-set", () => {
		expect(setting("cssModulesDevTools.pathAlias", { "@a": "/etc" }, workspace, true)).toEqual({
			value: { "@a": "/etc" },
			userSet: true,
		});
		expect(setting("cssModulesDevTools.pathAlias", {}, { defaultValue: {} }, true)).toEqual({
			value: {},
			userSet: false,
		});
	});

	test("untrusted workspaces can't set the other extensions' path settings", () => {
		expect(setting("cssModules.pathAlias", { "@a": "/etc" }, workspace, false)).toEqual({
			value: { "@a": "/user" },
			userSet: true,
		});
		const lookup = setting(
			"cssVariables.lookupFiles",
			["/etc/**/*.css"],
			{ workspaceValue: ["/etc/**/*.css"] },
			false,
		);
		expect(lookup).toEqual({ value: undefined, userSet: false });
		expect(
			setting(
				"typescript.preferences.importModuleSpecifier",
				"relative",
				{ workspaceValue: "relative" },
				false,
			),
		).toEqual({
			value: "relative",
			userSet: true,
		});
	});
});
