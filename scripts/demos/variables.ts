import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Hero.module.css",
	async setup(demo) {
		await demo.warmUp("--fg", "--fg");
		await demo.caretAfter("(--fg);");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.press("Enter");
		await demo.type("background: var(--");
		await demo.waitForSuggest("--brand");
		await demo.wait(600);
		// Expands the details pane so the focused variable's value is visible.
		await demo.press("Control+Space");
		await demo.wait(1400);
		await demo.type("bra", 140);
		await demo.wait(700);
		await demo.press("Enter");
		await demo.press("End");
		await demo.type(";");
		await demo.wait(500);
		// A non-color var: hovering a color var() also opens VS Code's color picker over the hover.
		await demo.hover("--space-4", { at: 4 });
		await demo.waitForHover("16px");
		await demo.wait(2400);
	},
} satisfies Scene;
