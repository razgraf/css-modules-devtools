import { describe, expect, test } from "bun:test";
import { Project, rulesFor } from "../src";

const FILE = "/v/a.module.css";

function setup(css: string) {
	const files = new Map([[FILE, css]]);
	return { files, project: new Project({ read: (f) => files.get(f) }) };
}

describe("rulesFor", () => {
	test("returns every rule referencing the class, in source order", () => {
		const { project } = setup(".a { top: 0 } .b { top: 1 } .a:hover, .c { top: 2 } .b .a { top: 3 }");
		expect(rulesFor(project, FILE, "a").map((r) => r.selector)).toEqual([".a", ".a:hover, .c", ".b .a"]);
		expect(rulesFor(project, FILE, "c").map((r) => r.selector)).toEqual([".a:hover, .c"]);
		expect(rulesFor(project, FILE, "missing")).toEqual([]);
		expect(rulesFor(project, "/v/none.module.css", "a")).toEqual([]);
	});

	test("results are independent copies", () => {
		const { project } = setup(".a { top: 0 }");
		rulesFor(project, FILE, "a").pop();
		expect(rulesFor(project, FILE, "a")).toHaveLength(1);
	});

	test("reflects the file after invalidation", () => {
		const { files, project } = setup(".a { top: 0 }");
		expect(rulesFor(project, FILE, "a")).toHaveLength(1);
		files.set(FILE, ".a { top: 0 } .a:focus { top: 1 }");
		project.invalidate(FILE);
		expect(rulesFor(project, FILE, "a").map((r) => r.selector)).toEqual([".a", ".a:focus"]);
	});
});
