import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type BuildOptions, build, type Plugin } from "esbuild";

const root = path.resolve(import.meta.dir, "..");
const client = path.join(root, "packages/client");
const production = process.argv.includes("--production");

const shared: BuildOptions = {
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	external: ["vscode"],
	sourcemap: "linked",
	minify: production,
	// ESM deps bundled into CJS lose `import.meta` (fdir calls `createRequire(import.meta.url)`).
	define: { "import.meta.url": "__importMetaUrl" },
	banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
	logLevel: "info",
};

// postcss skips previous-map handling when source-map-js is empty (its browser build relies on that) and
// only generates maps in LazyResult#stringify. The server only parses, so both are dead weight.
const stubSourceMaps: Plugin = {
	name: "stub-source-maps",
	setup(build) {
		build.onResolve({ filter: /^(source-map-js|\.\/map-generator)$/ }, ({ path: id, importer }) =>
			importer.includes(`${path.sep}postcss${path.sep}lib${path.sep}`)
				? { path: id, namespace: "stub" }
				: undefined,
		);
		build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
			contents: "module.exports = {};",
			loader: "js",
		}));
	},
};

await rm(path.join(client, "dist"), { recursive: true, force: true });

await Promise.all([
	build({
		...shared,
		entryPoints: { client: path.join(client, "src/extension.ts") },
		outdir: path.join(client, "dist"),
	}),
	build({
		...shared,
		entryPoints: { server: path.join(root, "packages/server/src/main.ts") },
		outdir: path.join(client, "dist"),
		plugins: [stubSourceMaps],
	}),
	build({
		...shared,
		entryPoints: { suite: path.join(client, "test-e2e/suite.ts") },
		outdir: path.join(client, "test-e2e/dist"),
		minify: false,
	}),
]);

// vsce packages the LICENSE, README, CHANGELOG and icon next to the manifest; the root copies are the source of truth.
for (const file of ["LICENSE", "README.md", "CHANGELOG.md"])
	await copyFile(path.join(root, file), path.join(client, file));
await copyFile(
	path.join(root, "assets/vscode-css-modules-devtools-icon-dark.png"),
	path.join(client, "icon.png"),
);
// `bun run package` writes the VSIX here and vsce doesn't create missing directories.
await mkdir(path.join(root, "dist"), { recursive: true });
