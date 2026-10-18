import fs from "node:fs";
import path from "node:path";
import { defaultSettings, Project, type Settings } from "@css-modules-devtools/core";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	type DocParams,
	defaultEnvironment,
	docParams,
	type Environment,
	FeatureContext,
} from "../src/context";
import { toUri } from "../src/lsp";

export const FIXTURES = path.resolve(import.meta.dir, "../../../fixtures");

export const fixture = (...parts: string[]) => path.join(FIXTURES, ...parts);

export interface Setup {
	ctx: FeatureContext;
	/**
	 * Open `file` (relative to the fixture root). `text` overrides the content on disk.
	 * A `|` in the text marks the cursor and is removed.
	 */
	open(file: string, text?: string): DocParams;
}

export function setup(
	root: string,
	settings: Partial<Settings> = {},
	env: Environment = defaultEnvironment,
): Setup {
	const overlay = new Map<string, string>();
	const project = new Project(
		{
			read: (file) => {
				if (overlay.has(file)) return overlay.get(file);
				try {
					return fs.readFileSync(file, "utf8");
				} catch {
					return undefined;
				}
			},
		},
		{ ...defaultSettings, ...settings },
		[fixture(root)],
	);
	const ctx = new FeatureContext(project, env);
	return {
		ctx,
		open(file, text) {
			const abs = fixture(root, file);
			const raw = text ?? fs.readFileSync(abs, "utf8");
			const cursor = raw.indexOf("|");
			const content = cursor === -1 ? raw : raw.slice(0, cursor) + raw.slice(cursor + 1);
			overlay.set(abs, content);
			project.invalidate(abs);
			const doc = TextDocument.create(toUri(abs), languageOf(abs), 1, content);
			const params = docParams(ctx, doc);
			return { ...params, offset: cursor === -1 ? 0 : cursor };
		},
	};
}

/** Text of `doc` with a cursor placed `delta` chars after the n-th occurrence of `needle`. */
export function cursorAt(text: string, needle: string, delta = 0, nth = 0): string {
	let index = -1;
	for (let i = 0; i <= nth; i++) {
		index = text.indexOf(needle, index + 1);
		if (index === -1) throw new Error(`"${needle}" not found`);
	}
	const at = index + delta;
	return `${text.slice(0, at)}|${text.slice(at)}`;
}

export const read = (root: string, file: string) => fs.readFileSync(fixture(root, file), "utf8");

function languageOf(file: string): string {
	if (file.endsWith(".css")) return "css";
	if (file.endsWith(".tsx")) return "typescriptreact";
	if (file.endsWith(".ts")) return "typescript";
	if (file.endsWith(".jsx")) return "javascriptreact";
	return "javascript";
}
