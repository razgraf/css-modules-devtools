import fs from "node:fs";
import path from "node:path";
import { type Project, type Settings, tsconfigPlugins } from "@css-modules-devtools/core";
import type { TextDocument } from "vscode-languageserver-textdocument";
import { toPath } from "./lsp";

/** Facts only the client can observe, sent alongside settings. */
export interface Environment {
	/** `mizdra.css-modules-kit-vscode` is installed and enabled. */
	cmkExtension: boolean;
	/** `typescript.experimental.useTsgo` is on (TS 7 native preview). */
	useTsgo: boolean;
}

export const defaultEnvironment: Environment = { cmkExtension: false, useTsgo: false };

const CMK_PLUGIN = "@css-modules-kit/ts-plugin";

export class FeatureContext {
	private readonly tsxCache = new Map<string, boolean>();

	constructor(
		readonly project: Project,
		public env: Environment = defaultEnvironment,
	) {}

	get settings(): Settings {
		return this.project.settings;
	}

	reset() {
		this.tsxCache.clear();
	}

	/** Whether class features run in this script file (`tsx.enabled`, with css-modules-kit hand-off on TS < 7). */
	tsxEnabled(file: string): boolean {
		const mode = this.settings.tsx.enabled;
		if (mode !== "auto") return mode === "on";
		const dir = path.dirname(file);
		const cached = this.tsxCache.get(dir);
		if (cached !== undefined) return cached;
		const enabled = !this.cmkActive(file);
		this.tsxCache.set(dir, enabled);
		return enabled;
	}

	private cmkActive(file: string): boolean {
		if (this.env.useTsgo || typescriptMajor(file) >= 7) return false;
		if (this.env.cmkExtension) return true;
		return tsconfigPlugins(file).includes(CMK_PLUGIN);
	}
}

export function typescriptMajor(file: string): number {
	let dir = path.dirname(file);
	while (true) {
		const manifest = path.join(dir, "node_modules", "typescript", "package.json");
		try {
			const version = JSON.parse(fs.readFileSync(manifest, "utf8")).version as string;
			return Number.parseInt(version, 10) || 0;
		} catch {
			// keep walking up
		}
		const parent = path.dirname(dir);
		if (parent === dir) return 0;
		dir = parent;
	}
}

export interface DocParams {
	ctx: FeatureContext;
	doc: TextDocument;
	file: string;
	text: string;
	offset: number;
}

export function docParams(
	ctx: FeatureContext,
	doc: TextDocument,
	position?: { line: number; character: number },
): DocParams {
	return {
		ctx,
		doc,
		file: toPath(doc.uri),
		text: doc.getText(),
		offset: position ? doc.offsetAt(position) : 0,
	};
}
