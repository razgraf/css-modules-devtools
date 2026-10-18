import type { Scene } from "./harness.ts";

export default {
	files: {
		"src/components/Button.tsx": `import styles from "./Button.module.css";

export function Button({ children }) {
	return (
		<button>
			{children}
		</button>
	);
}
`,
	},
	open: "src/components/Button.tsx",
	async setup(demo) {
		await demo.caretAfter("<button");
		await demo.type(" className={styles.", 0);
		await demo.waitForSuggest("primary");
		await demo.revert();
		await demo.caretAfter("<button");
		await demo.parkMouse();
	},
	async play(demo) {
		await demo.type(" className={styles.");
		await demo.waitForSuggest("primary");
		await demo.wait(1600);
		await demo.type("pri", 140);
		await demo.wait(900);
		await demo.press("Enter");
		await demo.wait(1800);
	},
} satisfies Scene;
