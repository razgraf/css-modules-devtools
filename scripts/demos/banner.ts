import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gifDir, root } from "./harness.ts";

const run = promisify(execFile);

// Mirrors the "vscode-css-modules-devtools-overview" frame in Figma: two copies of the overview grid,
// sheared 10° and stacked, the lower one with a top stroke the color of the grid gaps, then a bottom
// fade and the title. `title.png` is the Figma export of the logo and heading.
const size = { width: 1812, height: 1062 };
const background = "0x111219";
const stroke = { color: "0x1F2233", width: 6 };
const fade = { y: 939, height: 123 };
const title = { x: 39, y: 978, file: path.join(path.dirname(fileURLToPath(import.meta.url)), "title.png") };
const copies = [{ y: -729.4954833984375 }, { y: 354.4673767089844, stroke: true }];
// Figma stretches the image into its layer by this factor; the 10° skew then cancels it horizontally.
const stretch = 1078.383056640625 / size.height;
const slope = Math.tan((10 * Math.PI) / 180);
const fps = 12;

const variants = [
	{ name: "vscode-css-modules-devtools-overview", direction: 1 },
	{ name: "vscode-css-modules-devtools-overview-left", direction: -1 },
];

async function render(direction: number, out: string) {
	const height = Math.round(size.height * stretch);
	// ffmpeg's shear moves column x by -shy·(x - w/2) and drops the last column, hence the spare width.
	const width = size.width + 2;
	const margin = Math.ceil((slope * width) / 2) + 1;
	const shy = direction * slope;
	// Facing left mirrors the layout, not the content: each edge rises toward the left instead.
	const offset = direction === 1 ? 0 : -slope * size.width;

	const layers = copies.map((copy, i) => {
		const pad = copy.stroke ? stroke.width : 0;
		const top = Math.round(copy.y + offset - pad - margin - (shy * width) / 2);
		const chain = [
			copy.stroke ? `pad=${size.width}:${height + pad}:0:${pad}:${stroke.color}` : "null",
			`pad=${width}:${height + pad + 2 * margin}:0:${margin}:black@0`,
			`shear=shy=${shy}:fillcolor=black@0`,
		].join(",");
		return { filter: `[s${i}]${chain}[c${i}]`, top };
	});

	const filter = [
		`[0:v]fps=${fps},format=rgba,scale=${size.width}:${height}:flags=lanczos,split[s0][s1]`,
		...layers.map((layer) => layer.filter),
		`color=c=${background}:s=${size.width}x${size.height}:r=${fps},format=rgba[bg]`,
		`color=c=${background}:s=${size.width}x${fade.height}:r=${fps},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='(Y+0.5)/${fade.height}*255'[fade]`,
		`[bg][c0]overlay=0:${layers[0]?.top}:shortest=1[l0]`,
		`[l0][c1]overlay=0:${layers[1]?.top}[l1]`,
		`[l1][fade]overlay=0:${fade.y}:shortest=1[l2]`,
		`[l2][1:v]overlay=${title.x}:${title.y}:shortest=1,format=rgb24,split[a][b]`,
		"[a]palettegen=max_colors=256:stats_mode=full[p]",
		"[b][p]paletteuse=dither=none:diff_mode=rectangle",
	].join(";");

	await run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-i",
		path.join(gifDir, "overview.gif"),
		"-loop",
		"1",
		"-i",
		title.file,
		"-filter_complex",
		filter,
		"-loop",
		"0",
		out,
	]);
}

for (const { name, direction } of variants) {
	const out = path.join(gifDir, `${name}.gif`);
	await render(direction, out);
	const { size: bytes } = await stat(out);
	console.log(`${name}: ${path.relative(root, out)} ${(bytes / 1024).toFixed(0)} KB`);
}
