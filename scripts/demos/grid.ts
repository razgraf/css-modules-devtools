import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gifDir, record, root, type Scene } from "./harness.ts";

const run = promisify(execFile);

const tiles = [
	"completion",
	"hover",
	"definition",
	"missing-class",
	"auto-import",
	"composes",
	"variables",
	"colors",
	"global-shadow",
];
const columns = 3;
const tile = { width: 600, height: 350 };
// Tiles are recorded in a smaller window than the feature GIFs, so the code shrinks less in the grid.
const capture = { width: 800, height: 467 };
const gap = 6;
const fps = 12;
const hold = 1;
const fill = "0x1F2233";

const dir = await mkdtemp(path.join(os.tmpdir(), "cmd-grid-"));
try {
	const durations: number[] = [];
	for (const name of tiles) {
		const scene: Scene = (await import(`./${name}.ts`)).default;
		const { duration } = await record(name, scene, { size: capture, dir });
		durations.push(duration);
		console.log(`${name}: ${duration.toFixed(1)} s`);
	}
	const duration = Math.max(...durations) + hold;

	// Shorter scenes freeze on their last frame until the longest one ends, so every tile restarts together.
	const scaled = tiles.map(
		(_, i) =>
			`[${i}:v]fps=${fps},scale=${tile.width}:${tile.height}:flags=lanczos,tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS[t${i}]`,
	);
	const layout = tiles
		.map((_, i) => `${(i % columns) * (tile.width + gap)}_${Math.floor(i / columns) * (tile.height + gap)}`)
		.join("|");
	const filter = [
		...scaled,
		`${tiles.map((_, i) => `[t${i}]`).join("")}xstack=inputs=${tiles.length}:layout=${layout}:fill=${fill},split[a][b]`,
		"[a]palettegen=max_colors=256:stats_mode=full[p]",
		"[b][p]paletteuse=dither=none:diff_mode=rectangle",
	].join(";");

	const out = path.join(gifDir, "overview.gif");
	await run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		...tiles.flatMap((name) => ["-i", path.join(dir, `${name}.gif`)]),
		"-filter_complex",
		filter,
		"-loop",
		"0",
		out,
	]);
	const { size: bytes } = await stat(out);
	console.log(
		`overview: ${path.relative(root, out)} ${(bytes / 1024).toFixed(0)} KB, ${duration.toFixed(1)} s`,
	);
} finally {
	await rm(dir, { recursive: true, force: true });
}
