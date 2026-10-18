import { describe, expect, test } from "bun:test";
import { typescriptMajor } from "../src/context";
import { fixture, setup } from "./helpers";

const cmkApp = fixture("cmk-ts6", "src/App.tsx");
const nextApp = fixture("next-app", "src/components/Button.tsx");
const cmk = { cmkExtension: true, useTsgo: false };

describe("tsxEnabled", () => {
	test("on/off override detection", () => {
		expect(setup("cmk-ts6", { tsx: { enabled: "on" } }).ctx.tsxEnabled(cmkApp)).toBe(true);
		expect(setup("next-app", { tsx: { enabled: "off" } }).ctx.tsxEnabled(nextApp)).toBe(false);
	});

	test("auto defers to the cmk tsconfig plugin on TS < 7", () => {
		expect(typescriptMajor(cmkApp)).toBe(6);
		expect(setup("cmk-ts6").ctx.tsxEnabled(cmkApp)).toBe(false);
	});

	test("auto defers to the cmk extension on TS < 7", () => {
		const noPlugin = fixture("cmk-ts6", "ext-only/B.tsx");
		expect(setup("cmk-ts6").ctx.tsxEnabled(noPlugin)).toBe(true);
		expect(setup("cmk-ts6", {}, cmk).ctx.tsxEnabled(noPlugin)).toBe(false);
	});

	test("auto keeps features on TS 7", () => {
		expect(setup("cmk-ts6", {}, { cmkExtension: true, useTsgo: true }).ctx.tsxEnabled(cmkApp)).toBe(true);
		expect(typescriptMajor(nextApp)).toBe(7);
		expect(setup("next-app", {}, cmk).ctx.tsxEnabled(nextApp)).toBe(true);
	});
});
