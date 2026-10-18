import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDevelopmentPath = path.join(root, "packages/client");
const extensionTestsPath = path.join(extensionDevelopmentPath, "test-e2e/dist/suite.js");
const fixture = path.join(root, "fixtures/e2e-css");
// Oldest supported release (engines.vscode); override with VSCODE_VERSION=stable.
const version = process.env.VSCODE_VERSION ?? "1.85.0";

const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "cmd-e2e-")));
// VS Code percent-encodes `@`, spaces, `+` and parentheses in URIs while Node's `pathToFileURL` does not,
// so the suite also runs from a copy whose path needs that encoding.
const encoded = path.join(scratch, "@scope", "next app (x+y)");
await cp(fixture, encoded, { recursive: true });

try {
	for (const [index, workspace] of [fixture, encoded].entries()) {
		console.log(`\ne2e workspace: ${workspace}`);
		await runTests({
			version,
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				workspace,
				"--disable-extensions",
				"--disable-workspace-trust",
				"--skip-welcome",
				"--skip-release-notes",
				`--user-data-dir=${path.join(scratch, `user-data-${index}`)}`,
			],
		});
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
} finally {
	await rm(scratch, { recursive: true, force: true });
}
