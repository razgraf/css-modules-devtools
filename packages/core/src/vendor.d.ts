declare module "postcss-safe-parser" {
	import type { Root } from "postcss";

	const parse: (css: string) => Root;
	export default parse;
}
