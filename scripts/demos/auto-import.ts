import type { Scene } from "./harness.ts";

export default {
	files: {
		"src/components/Badge.tsx": `export function Badge({ label }) {
	return <span>{label}</span>;
}
`,
	},
	open: "src/components/Badge.tsx",
	async setup(demo) {
		await demo.caretAfter("<span");
		await demo.type(" className={styles", 0);
		await demo.dismissSuggest();
		await demo.type(".", 0);
		await demo.waitForSuggest("success");
		await demo.revert();
		await demo.caretAfter("<span");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.type(" className={styles");
		// TS's global `StyleSheet` fuzzy-matches `styles` and would be committed by `.`.
		await demo.dismissSuggest();
		await demo.type(".");
		await demo.waitForSuggest("success");
		await demo.wait(1600);
		await demo.type("suc", 140);
		await demo.wait(800);
		await demo.press("Enter");
		await demo.wait(2200);
	},
} satisfies Scene;
