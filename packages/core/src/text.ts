import type { Loc, Pos } from "./types";

export class LineIndex {
	private readonly starts: number[] = [0];

	constructor(readonly text: string) {
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
		}
	}

	pos(offset: number): Pos {
		const clamped = Math.max(0, Math.min(offset, this.text.length));
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((this.starts[mid] ?? 0) <= clamped) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo, character: clamped - (this.starts[lo] ?? 0), offset: clamped };
	}

	offset(line: number, character: number): number {
		const start = this.starts[line];
		if (start === undefined) return this.text.length;
		return Math.min(start + character, this.text.length);
	}

	loc(file: string, start: number, end: number): Loc {
		return { file, start: this.pos(start), end: this.pos(end) };
	}
}

export function contains(loc: Loc, offset: number): boolean {
	return offset >= loc.start.offset && offset <= loc.end.offset;
}
