import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Card.module.css",
	async setup(demo) {
		await demo.warmUp("--surface", "--surface");
		await demo.caretAfter('composes: elevated from "@/styles/base.module.css";');
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.press("Enter");
		await demo.type("--brand: #ff4d8d");
		await demo.press("Escape");
		await demo.type(";");
		await demo.waitForSquiggle("warning");
		await demo.wait(600);
		await demo.hover("--brand", { at: 4 });
		await demo.waitForHover("shadows a global variable");
		await demo.wait(2800);
	},
} satisfies Scene;
