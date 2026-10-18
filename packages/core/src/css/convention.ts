import type { Convention } from "../types";

// Ported from css-loader v7.1.5 (src/utils.js: preserveCamelCase, camelCase, dashesCamelCase)
// so exported keys match `exportLocalsConvention` byte for byte.
function preserveCamelCase(input: string): string {
	let result = input;
	let isLastCharLower = false;
	let isLastCharUpper = false;
	let isLastLastCharUpper = false;

	for (let i = 0; i < result.length; i++) {
		const character = result.charAt(i);

		if (isLastCharLower && /\p{Lu}/u.test(character)) {
			result = `${result.slice(0, i)}-${result.slice(i)}`;
			isLastCharLower = false;
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = true;
			i += 1;
		} else if (isLastCharUpper && isLastLastCharUpper && /\p{Ll}/u.test(character)) {
			result = `${result.slice(0, i - 1)}-${result.slice(i - 1)}`;
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = false;
			isLastCharLower = true;
		} else {
			isLastCharLower = character.toLowerCase() === character && character.toUpperCase() !== character;
			isLastLastCharUpper = isLastCharUpper;
			isLastCharUpper = character.toUpperCase() === character && character.toLowerCase() !== character;
		}
	}

	return result;
}

function camelCase(input: string): string {
	let result = input.trim();
	if (result.length === 0) return "";
	if (result.length === 1) return result.toLowerCase();
	if (result !== result.toLowerCase()) result = preserveCamelCase(result);

	return result
		.replace(/^[_.\- ]+/, "")
		.toLowerCase()
		.replace(/[_.\- ]+([\p{Alpha}\p{N}_]|$)/gu, (_, c: string) => c.toUpperCase())
		.replace(/\d+([\p{Alpha}\p{N}_]|$)/gu, (m) => m.toUpperCase());
}

function dashesCamelCase(input: string): string {
	return input.replace(/-+(\w)/g, (_, c: string) => c.toUpperCase());
}

/** Keys a class is exported under, mirroring css-loader's `exportLocalsConvention`. */
export function keysFor(className: string, convention: Convention): string[] {
	switch (convention) {
		case "asIs":
			return [className];
		case "camelCase":
			return unique([className, camelCase(className)]);
		case "camelCaseOnly":
			return [camelCase(className)];
		case "dashes":
			return unique([className, dashesCamelCase(className)]);
		case "dashesOnly":
			return [dashesCamelCase(className)];
	}
}

/** Map of exported key → class name for a set of class names. */
export function exportMap(classNames: Iterable<string>, convention: Convention): Map<string, string> {
	const map = new Map<string, string>();
	for (const name of classNames) {
		for (const key of keysFor(name, convention)) {
			if (!map.has(key)) map.set(key, name);
		}
	}
	return map;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
