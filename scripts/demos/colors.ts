import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Status.module.css",
	async setup(demo) {
		await demo.waitForColors();
		// The overview's smaller window can't fit the whole file; bring the edited lines into view.
		await demo.press("Meta+ArrowDown");
		await demo.caretAfter("(--fg);");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.wait(1800);
		await demo.press("Enter");
		await demo.type("border-color: var(--danger");
		await demo.press("Escape");
		await demo.type(");");
		await demo.wait(2200);
	},
} satisfies Scene;
