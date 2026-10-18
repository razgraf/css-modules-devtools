import { access } from "node:fs/promises";
import path from "node:path";
import { record, root, type Scene } from "./harness.ts";

const names = [
	"completion",
	"definition",
	"hover",
	"missing-class",
	"auto-import",
	"composes",
	"variables",
	"colors",
	"global-shadow",
];

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !names.includes(name));
if (unknown.length) {
	console.error(`unknown demo(s): ${unknown.join(", ")}\navailable: ${names.join(", ")}`);
	process.exit(1);
}

try {
	await access(path.join(root, "packages/client/dist/client.js"));
} catch {
	console.error("extension not built; run `bun run build` first");
	process.exit(1);
}

let failed = false;
for (const name of requested.length ? requested : names) {
	const scene: Scene = (await import(`./${name}.ts`)).default;
	const started = Date.now();
	try {
		const { out, bytes, duration } = await record(name, scene);
		const kb = (bytes / 1024).toFixed(0);
		console.log(
			`${name}: ${path.relative(root, out)} ${kb} KB, ${duration.toFixed(1)} s (${((Date.now() - started) / 1000).toFixed(0)} s)`,
		);
		if (bytes > 1.5 * 1024 * 1024) console.warn(`  ${name}.gif is over 1.5 MB`);
	} catch (error) {
		failed = true;
		console.error(`${name}: failed\n`, error);
	}
}
process.exitCode = failed ? 1 : 0;
