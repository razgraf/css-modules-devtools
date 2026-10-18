import type { Scene } from "./harness.ts";

export default {
	open: "src/components/Button.tsx",
	async setup(demo) {
		await demo.warmUp("styles.button", ".button");
		await demo.caretAfter("{children}");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.hover("styles.button", { at: 10 });
		await demo.wait(500);
		await demo.page.keyboard.down("Meta");
		await demo.waitForHover("composes");
		await demo.wait(1600);
		const target = await demo.locate("styles.button", { at: 10 });
		await demo.page.mouse.click(target.x, target.y);
		await demo.page.keyboard.up("Meta");
		await demo.page.locator(".peekview-widget").first().waitFor({ timeout: 15_000 });
		await demo.parkMouse();
		await demo.wait(2600);
	},
} satisfies Scene;
