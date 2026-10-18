import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Alert.module.css",
	async setup(demo) {
		await demo.warmUp("--radius", "--radius");
		await demo.caretAfter(".alert {");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.press("Enter");
		await demo.type('composes:  from "@/styles/base.module.css');
		await demo.press("Escape");
		await demo.press("End");
		await demo.type(";");
		await demo.wait(250);
		await demo.press("Home");
		await demo.press("ArrowRight", 10, 40);
		await demo.wait(300);
		await demo.press("Control+Space");
		await demo.waitForSuggest("focus");
		await demo.wait(1200);
		await demo.type("fo", 140);
		await demo.wait(600);
		await demo.press("Enter");
		await demo.wait(450);
		await demo.hover("focus", { at: 4 });
		await demo.waitForHover("outline-offset");
		await demo.wait(2000);
	},
} satisfies Scene;
