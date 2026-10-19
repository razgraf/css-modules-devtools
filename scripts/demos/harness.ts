/// <reference lib="dom" />
// DOM types cover the callbacks that run inside the VS Code window (page.evaluate).
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from "@vscode/test-electron";
import { _electron, type CDPSession, type ElectronApplication, type Page } from "playwright";

const run = promisify(execFile);

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const gifDir = path.join(root, "assets");

const fixture = path.join(root, "fixtures/demo");
const extension = path.join(root, "packages/client");
const version = "1.85.0";
const theme = { id: "t3dotgg.vsc-material-theme-but-i-wont-sue-you", version: "35.0.3" };
const themeDir = path.join(root, ".vscode-test/demo-extensions");

export type Size = { width: number; height: number };

const defaultSize: Size = { width: 1200, height: 700 };
const fps = 12;
const typingDelay = 50;

// Window-level chrome is hidden through settings; the native macOS title bar lives outside the
// recorded web contents, so the video only ever contains the workbench.
const settings = {
	"workbench.colorTheme": "Material Theme Ocean High Contrast",
	"editor.fontSize": 16,
	"editor.lineHeight": 24,
	"window.titleBarStyle": "native",
	"window.commandCenter": false,
	"window.restoreWindows": "none",
	"window.zoomLevel": 0,
	"workbench.layoutControl.enabled": false,
	"workbench.activityBar.visible": false,
	"workbench.statusBar.visible": false,
	"workbench.startupEditor": "none",
	"workbench.editor.showTabs": false,
	"workbench.tips.enabled": false,
	"workbench.editor.decorations.colors": false,
	"workbench.editor.decorations.badges": false,
	"workbench.enableExperiments": false,
	"workbench.tree.renderIndentGuides": "none",
	"editor.minimap.enabled": false,
	"editor.scrollbar.vertical": "hidden",
	"editor.scrollbar.horizontal": "hidden",
	"editor.overviewRulerLanes": 0,
	"editor.hideCursorInOverviewRuler": true,
	"editor.stickyScroll.enabled": false,
	"editor.cursorBlinking": "solid",
	"editor.hover.delay": 250,
	"editor.accessibilitySupport": "off",
	"editor.renderLineHighlight": "none",
	"breadcrumbs.enabled": false,
	"css.lint.unknownProperties": "ignore",
	// Built-in MDN property docs would otherwise share the hover with the extension's content.
	"css.hover.documentation": false,
	"css.hover.references": false,
	"emmet.showExpandedAbbreviation": "never",
	"extensions.ignoreRecommendations": true,
	"extensions.autoCheckUpdates": false,
	"git.enabled": false,
	"telemetry.telemetryLevel": "off",
	"update.mode": "none",
	"security.workspace.trust.enabled": false,
};

const cursorId = "demo-cursor";
const injectedStyle = `
.part.editor .title .title-actions, .part.editor .title .editor-actions, .peekview-title .dirname, .notifications-toasts, .notification-toast-container { display: none !important; }
.monaco-scrollable-element > .scrollbar, .monaco-scrollable-element > .shadow, .decorationsOverviewRuler { display: none !important; }
#${cursorId} { position: fixed; left: 0; top: 0; width: 18px; height: 26px; z-index: 2147483646;
  pointer-events: none; display: none; transform: translate(-2px, -2px);
  background: url("data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="26" viewBox="0 0 18 26"><path d="M1 1v20l5-5 4 9 3-1.4-4-8.8h7z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
	)}") no-repeat; }
`;

export type Point = { x: number; y: number };

export class Demo {
	readonly page: Page;
	private readonly app: ElectronApplication;
	private readonly size: Size;

	constructor(app: ElectronApplication, page: Page, size: Size) {
		this.app = app;
		this.page = page;
		this.size = size;
	}

	wait(ms: number) {
		return this.page.waitForTimeout(ms);
	}

	async type(text: string, delay = typingDelay) {
		await this.page.keyboard.type(text, { delay });
	}

	async press(key: string, times = 1, delay = 60) {
		for (let i = 0; i < times; i++) {
			await this.page.keyboard.press(key);
			if (delay) await this.wait(delay);
		}
	}

	async open(file: string) {
		await this.press("Meta+P");
		await this.page.waitForSelector(".quick-input-widget:not([style*='display: none'])");
		await this.page.keyboard.type(file);
		await this.page.waitForSelector(
			`.quick-input-list .monaco-list-row[aria-label*="${path.basename(file)}"]`,
		);
		await this.press("Enter");
		await this.waitForEditor(path.basename(file));
		await this.wait(300);
	}

	async waitForEditor(name: string) {
		await this.page.waitForSelector(`.part.editor .title .label-name:text-is("${name}")`);
		await this.page.waitForSelector(".part.editor .monaco-editor.focused");
	}

	/** Viewport point of `text` in the active editor: `at` = char offset inside the match (default: center). */
	async locate(text: string, opts: { nth?: number; at?: number; after?: boolean } = {}): Promise<Point> {
		const point = await this.page.evaluate(
			({ text, nth, at, after }) => {
				const editor = document.querySelector(".part.editor .editor-instance .monaco-editor .view-lines");
				if (!editor) return null;
				const lines = [...editor.querySelectorAll<HTMLElement>(".view-line")].sort(
					(a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
				);
				let seen = 0;
				for (const line of lines) {
					const nodes: Text[] = [];
					const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
					while (walker.nextNode()) nodes.push(walker.currentNode as Text);
					const content = nodes
						.map((n) => n.data)
						.join("")
						.replace(/ /g, " ");
					let index = content.indexOf(text);
					while (index !== -1) {
						if (seen++ === nth) {
							const offset = index + (at ?? Math.floor(text.length / 2));
							let rest = offset;
							for (const node of nodes) {
								if (rest < node.data.length) {
									const range = document.createRange();
									range.setStart(node, rest);
									range.setEnd(node, rest + 1);
									const rect = range.getBoundingClientRect();
									return {
										x: after ? rect.right - 1 : rect.left + rect.width / 2,
										y: rect.top + rect.height / 2,
									};
								}
								rest -= node.data.length;
							}
						}
						index = content.indexOf(text, index + 1);
					}
				}
				return null;
			},
			{ text, nth: opts.nth ?? 0, at: opts.at ?? null, after: opts.after ?? false },
		);
		if (!point) throw new Error(`text not visible in editor: ${text}`);
		return point;
	}

	async moveTo(target: Point, steps = 18) {
		await this.page.mouse.move(target.x, target.y, { steps });
	}

	async hover(text: string, opts: { nth?: number; at?: number } = {}) {
		await this.moveTo(await this.locate(text, opts));
	}

	/** Puts the caret right after `text` (or after its `at`-th char) with a click. */
	async caretAfter(text: string, opts: { nth?: number; at?: number } = {}) {
		const at = opts.at ?? text.length - 1;
		const point = await this.locate(text, { ...opts, at, after: true });
		await this.moveTo(point, 10);
		await this.page.mouse.click(point.x, point.y);
	}

	/** Moves the pointer out of the way (closing any hover) and hides it until the next move. */
	async parkMouse() {
		await this.moveTo({ x: this.size.width - 60, y: this.size.height - 60 }, 12);
		await this.page.evaluate((id) => {
			const el = document.getElementById(id);
			if (!el?.hasAttribute("data-armed")) return;
			el.style.display = "none";
			el.setAttribute("data-armed", `${el.style.left},${el.style.top}`);
		}, cursorId);
	}

	async waitForSuggest(label: string) {
		await this.page
			.locator(".editor-widget.suggest-widget.visible .monaco-list-row")
			.filter({ hasText: label })
			.first()
			.waitFor({ timeout: 15_000 });
	}

	/** Closes the suggest widget once it has opened (Escape before it opens is a no-op). */
	async dismissSuggest() {
		await this.page.locator(".editor-widget.suggest-widget.visible").waitFor({ timeout: 15_000 });
		await this.press("Escape");
	}

	async waitForHover(text: string) {
		await this.page
			.locator(".monaco-hover:not(.hidden) .monaco-hover-content")
			.filter({ hasText: text })
			.first()
			.waitFor({ timeout: 15_000 });
	}

	/** Moves the pointer into the open hover and scrolls it down by `pixels`, a notch at a time. */
	async scrollHover(pixels: number, notch = 40, delay = 90) {
		const box = await this.page
			.locator(".monaco-hover:not(.hidden) .monaco-hover-content")
			.first()
			.boundingBox();
		if (!box) throw new Error("no hover open");
		await this.moveTo({ x: box.x + box.width * 0.6, y: box.y + box.height / 2 }, 14);
		// Neither Playwright's mouse.wheel nor a dispatched WheelEvent scrolls the hover in Electron; move scrollTop.
		for (let done = 0; done < pixels; done += notch) {
			await this.page.evaluate((step) => {
				const content = document.querySelector<HTMLElement>(
					".monaco-hover:not(.hidden) .monaco-hover-content",
				);
				if (content) content.scrollTop += step;
			}, notch);
			await this.wait(delay);
		}
	}

	async waitForSquiggle(kind: "error" | "warning") {
		await this.page
			.locator(`.part.editor .view-overlays .squiggly-${kind}`)
			.first()
			.waitFor({ timeout: 15_000 });
	}

	async waitForColors() {
		await this.page
			.locator(".part.editor .colorpicker-color-decoration")
			.first()
			.waitFor({ timeout: 15_000 });
	}

	/** Opens the quick fix menu and accepts the entry containing `label`. */
	async quickFix(label: string) {
		await this.press("Meta+.");
		const rows = this.page.locator(".action-widget .monaco-list-row.action");
		await rows.filter({ hasText: label }).first().waitFor({ timeout: 15_000 });
		const labels = await rows.allTextContents();
		const index = labels.findIndex((l) => l.includes(label));
		await this.wait(900);
		await this.press("ArrowDown", index, 250);
		await this.wait(500);
		await this.press("Enter");
	}

	/** Warm-up before the scene starts: waits until the language server answers a hover. */
	async warmUp(text: string, expect: string) {
		for (let attempt = 1; ; attempt++) {
			await this.hover(text, { at: text.length - 2 });
			try {
				await this.waitForHover(expect);
				break;
			} catch (error) {
				if (attempt === 4) throw error;
				await this.page.mouse.move(this.size.width - 60, this.size.height - 60);
				await this.press("Escape");
			}
		}
		await this.page.mouse.move(this.size.width - 60, this.size.height - 60);
		await this.press("Escape");
		await this.wait(400);
	}

	/** Reverts edits made during setup (the undo stack starts at the opened file). */
	async revert() {
		await this.press("Escape");
		await this.press("Meta+Z", 12, 30);
		await this.wait(300);
	}

	/** The fake pointer (the recording has no OS cursor) appears on the first mouse move of the scene. */
	async armCursor() {
		await this.page.evaluate((id) => {
			const el = document.getElementById(id);
			el?.setAttribute("data-armed", `${el.style.left},${el.style.top}`);
		}, cursorId);
	}

	async close() {
		await this.app.close();
	}
}

export type Scene = {
	/** Files written into the workspace copy before launch. */
	files?: Record<string, string>;
	/** File opened before recording starts. */
	open: string;
	/** Runs before the scene: caret placement, warm-up. Not part of the GIF. */
	setup?: (demo: Demo) => Promise<void>;
	/** The recorded part. */
	play: (demo: Demo) => Promise<void>;
};

/** Installs the color theme once into a cached extensions dir, reused by every scene. */
async function installTheme(executablePath: string) {
	const installed = await readdir(themeDir).catch((): string[] => []);
	if (installed.includes(`${theme.id}-${theme.version}`)) return;
	await run(resolveCliPathFromVSCodeExecutablePath(executablePath), [
		`--extensions-dir=${themeDir}`,
		"--install-extension",
		`${theme.id}@${theme.version}`,
	]);
}

async function launch(scratch: string, scene: Scene, size: Size) {
	const workspace = path.join(scratch, "demo");
	await cp(fixture, workspace, { recursive: true });
	for (const [rel, content] of Object.entries(scene.files ?? {})) {
		await mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
		await writeFile(path.join(workspace, rel), content);
	}
	const userData = path.join(scratch, "u");
	await mkdir(path.join(userData, "User"), { recursive: true });
	await writeFile(path.join(userData, "User/settings.json"), JSON.stringify(settings, null, "\t"));

	const executablePath = await downloadAndUnzipVSCode({
		version,
		cachePath: path.join(root, ".vscode-test"),
	});
	await installTheme(executablePath);
	const app = await _electron.launch({
		executablePath,
		args: [
			workspace,
			`--extensionDevelopmentPath=${extension}`,
			`--user-data-dir=${userData}`,
			`--extensions-dir=${themeDir}`,
			"--skip-welcome",
			"--skip-release-notes",
			"--disable-workspace-trust",
			"--disable-telemetry",
			"--disable-updates",
			"--disable-gpu-sandbox",
		],
	});
	const page = await app.firstWindow();
	await page.waitForSelector(".monaco-workbench");
	const window = await app.browserWindow(page);
	await window.evaluate((win, s) => win.setContentSize(s.width, s.height), size);
	await page.addStyleTag({ content: injectedStyle });
	await page.evaluate((id) => {
		const el = document.createElement("div");
		el.id = id;
		document.body.append(el);
		document.addEventListener(
			"mousemove",
			(event) => {
				el.style.left = `${event.clientX}px`;
				el.style.top = `${event.clientY}px`;
				// Chromium also fires mousemove on layout changes; only a real move reveals the pointer.
				const armed = el.getAttribute("data-armed");
				if (armed !== null && armed !== `${el.style.left},${el.style.top}`) el.style.display = "block";
			},
			true,
		);
	}, cursorId);
	return { app, page };
}

async function prepareLayout(demo: Demo) {
	// The side bar and panel restore from the (fresh) profile's defaults; close them via commands.
	for (const command of ["View: Close Primary Side Bar", "View: Close Panel"]) {
		await demo.press("Meta+Shift+P");
		await demo.page.waitForSelector(".quick-input-widget:not([style*='display: none'])");
		await demo.page.keyboard.type(command);
		await demo.wait(400);
		await demo.press("Enter");
		await demo.wait(300);
	}
	await demo.page.waitForSelector(".part.sidebar", { state: "hidden" });
}

type Frame = { data: Buffer; time: number };

/**
 * Lossless capture via the DevTools screencast: Chromium only emits a frame when the page repaints,
 * with its timestamp, so the scene is cut exactly and idle stretches cost nothing. (Playwright's
 * recordVideo goes through lossy VP8, whose per-frame noise defeats GIF frame diffing.)
 */
class Recorder {
	private readonly frames: Frame[] = [];
	private end = 0;
	private session?: CDPSession;
	private readonly page: Page;
	private readonly size: Size;

	constructor(page: Page, size: Size) {
		this.page = page;
		this.size = size;
	}

	async start() {
		const session = await this.page.context().newCDPSession(this.page);
		this.session = session;
		session.on("Page.screencastFrame", (event) => {
			this.frames.push({
				data: Buffer.from(event.data, "base64"),
				time: event.metadata.timestamp ?? Date.now() / 1000,
			});
			session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
		});
		await session.send("Page.startScreencast", {
			format: "png",
			maxWidth: this.size.width,
			maxHeight: this.size.height,
		});
	}

	async stop() {
		this.end = Date.now() / 1000;
		await this.session?.send("Page.stopScreencast");
		await this.session?.detach();
	}

	/** Writes the frames plus an ffmpeg concat list carrying each frame's on-screen duration. */
	async write(dir: string) {
		if (!this.frames.length) throw new Error("no frames captured");
		await mkdir(dir, { recursive: true });
		const lines: string[] = [];
		for (const [i, frame] of this.frames.entries()) {
			const file = path.join(dir, `${String(i).padStart(5, "0")}.png`);
			await writeFile(file, frame.data);
			const next = this.frames[i + 1]?.time ?? this.end;
			lines.push(`file '${file}'`, `duration ${Math.max(next - frame.time, 0.001).toFixed(4)}`);
		}
		// The concat demuxer ignores the last entry's duration unless the file is repeated; the repeat
		// itself is then cut off by `-t` in toGif.
		lines.push(lines.at(-2) ?? "");
		const list = path.join(dir, "frames.txt");
		await writeFile(list, `${lines.join("\n")}\n`);
		return { list, duration: this.end - (this.frames[0]?.time ?? this.end) };
	}
}

async function toGif(list: string, duration: number, out: string, size: Size) {
	const filter = [
		`[0:v]fps=${fps},scale=${size.width}:${size.height}:flags=lanczos,split[a][b]`,
		"[a]palettegen=max_colors=128:stats_mode=full[p]",
		"[b][p]paletteuse=dither=none:diff_mode=rectangle",
	].join(";");
	await run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-f",
		"concat",
		"-safe",
		"0",
		"-i",
		list,
		"-filter_complex",
		filter,
		"-t",
		duration.toFixed(3),
		"-loop",
		"0",
		out,
	]);
}

export async function record(name: string, scene: Scene, { size = defaultSize, dir = gifDir } = {}) {
	// realpath: /var → /private/var on macOS; VS Code otherwise shows absolute paths in labels.
	const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "cmd-demo-")));
	try {
		const { app, page } = await launch(scratch, scene, size);
		const demo = new Demo(app, page, size);
		const recorder = new Recorder(page, size);
		try {
			await prepareLayout(demo);
			await demo.open(scene.open);
			await scene.setup?.(demo);
			await demo.wait(500);
			await demo.armCursor();
			await recorder.start();
			await demo.wait(600);
			await scene.play(demo);
			await recorder.stop();
		} catch (error) {
			const shot = path.join(os.tmpdir(), `demo-${name}-error.png`);
			await demo.page.screenshot({ path: shot }).catch(() => {});
			console.error(`screenshot of the failure: ${shot}`);
			throw error;
		} finally {
			await demo.close();
		}
		const { list, duration } = await recorder.write(path.join(scratch, "frames"));
		if (process.env.DEMO_DEBUG_FRAMES)
			await cp(path.join(scratch, "frames"), process.env.DEMO_DEBUG_FRAMES, { recursive: true });
		await mkdir(dir, { recursive: true });
		const out = path.join(dir, `${name}.gif`);
		await toGif(list, duration, out, size);
		const { size: bytes } = await stat(out);
		return { out, bytes, duration };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
