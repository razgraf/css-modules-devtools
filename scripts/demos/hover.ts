import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Card.tsx",
	async setup(demo) {
		await demo.warmUp("styles.card", ".card");
		await demo.caretAfter("{children}");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.hover("styles.card", { at: 8 });
		await demo.waitForHover("composed");
		await demo.wait(1400);
		await demo.scrollHover(200);
		await demo.wait(2400);
	},
} satisfies Scene;
