import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Status.module.css",
	async setup(demo) {
		await demo.waitForColors();
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
