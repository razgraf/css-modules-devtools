import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { RESTRICTED_FALLBACKS, SECTION, WATCHED_SECTIONS } from "../src/config";

interface Manifest {
	engines: Record<string, string>;
	preview?: boolean;
	homepage?: string;
	galleryBanner?: { color: string; theme: string };
	capabilities?: {
		untrustedWorkspaces?: { supported: boolean | "limited"; restrictedConfigurations?: string[] };
		virtualWorkspaces?: boolean;
	};
	contributes: { configuration: { properties: Record<string, unknown> }; css?: { customData?: string[] } };
}

const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../package.json"), "utf8"));

test("untrusted workspaces can't redirect resolution or globs", () => {
	const untrusted = manifest.capabilities?.untrustedWorkspaces;
	expect(untrusted?.supported).toBe("limited");
	expect(untrusted?.restrictedConfigurations?.sort()).toEqual(
		["globalFiles", "nodeModules.enabled", "pathAlias"].map((key) => `${SECTION}.${key}`),
	);
	for (const key of untrusted?.restrictedConfigurations ?? []) {
		expect(manifest.contributes.configuration.properties).toHaveProperty([key]);
	}
	for (const fallback of RESTRICTED_FALLBACKS) expect(WATCHED_SECTIONS).toContain(fallback);
	expect(manifest.capabilities?.virtualWorkspaces).toBe(false);
});

test("css custom data ships with the VSIX and declares composes", () => {
	const files = manifest.contributes.css?.customData ?? [];
	expect(files).toEqual(["./css-data.json"]);
	const ignore = fs.readFileSync(path.join(import.meta.dir, "../.vscodeignore"), "utf8").split("\n");
	for (const file of files) {
		expect(ignore).toContain(`!${path.basename(file)}`);
		const data = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", file), "utf8"));
		expect(data.properties.map((p: { name: string }) => p.name)).toContain("composes");
	}
});

test("marketplace metadata", () => {
	expect(Object.keys(manifest.engines)).toEqual(["vscode"]);
	expect(manifest.preview).toBe(true);
	expect(manifest.homepage).toMatch(/^https:\/\//);
	expect(manifest.galleryBanner).toEqual({ color: expect.stringMatching(/^#[0-9a-f]{6}$/i), theme: "dark" });
});
