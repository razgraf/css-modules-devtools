import { describe, expect, test } from "bun:test";
import { IDENT_RE, relativeSpecifier } from "../src/lsp";

describe("relativeSpecifier", () => {
	test("siblings and children get ./", () => {
		expect(relativeSpecifier("/p/src/a.module.css", "/p/src/A.tsx")).toBe("./a.module.css");
		expect(relativeSpecifier("/p/src/ui/b.module.css", "/p/src/A.tsx")).toBe("./ui/b.module.css");
	});

	test("parents keep ../", () => {
		expect(relativeSpecifier("/p/styles/c.module.css", "/p/src/deep/A.tsx")).toBe(
			"../../styles/c.module.css",
		);
	});

	test("dot-files still get ./", () => {
		expect(relativeSpecifier("/p/src/.d.module.css", "/p/src/A.tsx")).toBe("./.d.module.css");
	});
});

describe("IDENT_RE", () => {
	test("JS identifiers only", () => {
		for (const key of ["a", "_a", "$a", "aB1"]) expect(IDENT_RE.test(key)).toBe(true);
		for (const key of ["a-b", "1a", "", "a.b"]) expect(IDENT_RE.test(key)).toBe(false);
	});
});
