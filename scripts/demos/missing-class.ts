import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Button.tsx",
	async setup(demo) {
		await demo.warmUp("styles.button", ".button");
		await demo.caretAfter("{children}");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.press("Enter");
		await demo.type("<span className={styles.buton");
		await demo.press("Escape");
		await demo.press("End");
		await demo.type(" />");
		await demo.waitForSquiggle("error");
		await demo.wait(600);
		await demo.hover("styles.buton", { at: 9 });
		await demo.waitForHover("does not exist");
		await demo.wait(1800);
		await demo.caretAfter("styles.buton", { at: 9 });
		await demo.parkMouse();
		await demo.quickFix("Did you mean 'button'?");
		await demo.wait(1800);
	},
} satisfies Scene;
