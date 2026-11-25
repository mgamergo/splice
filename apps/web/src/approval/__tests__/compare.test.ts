import { describe, expect, test } from "bun:test";
import { s, videoClip } from "@/agent/__tests__/fixtures";
import type { Marker, SequenceTracks, VideoClip } from "@/timeline/types";
import { buildDefaultSequence } from "@/timeline/sequences";
import { alignLists, type ComparableEdit, compareEdits } from "../compare";

function edit({
	clips,
	markers = [],
	cues = [],
}: {
	clips: VideoClip[];
	markers?: Marker[];
	cues?: ComparableEdit["cues"];
}): ComparableEdit {
	const { tracks } = buildDefaultSequence({ name: "S", isMain: true });
	const main = { ...tracks.main, id: "v1", clips };
	return {
		tracks: { ...tracks, main } satisfies SequenceTracks,
		markers,
		cues,
	};
}

const approved = edit({
	clips: [
		videoClip({ id: "a", start: 0, duration: 4, trimStart: 0 }),
		videoClip({ id: "b", start: 4, duration: 3, trimStart: 10 }),
		videoClip({ id: "c", start: 7, duration: 5, trimStart: 20 }),
	],
});

describe("comparing with the approved cut", () => {
	test("the same edit has no changes", () => {
		const result = compareEdits({ approved, current: approved });
		expect(result.identical).toBe(true);
		expect(result.passages).toEqual([]);
	});

	test("a razor that changes nothing isn't a change", () => {
		const current = edit({
			clips: [
				videoClip({ id: "a", start: 0, duration: 4, trimStart: 0 }),
				videoClip({ id: "b", start: 4, duration: 1, trimStart: 10 }),
				videoClip({ id: "b2", start: 5, duration: 2, trimStart: 11 }),
				videoClip({ id: "c", start: 7, duration: 5, trimStart: 20 }),
			],
		});
		expect(compareEdits({ approved, current }).identical).toBe(true);
	});

	test("a ripple delete is one removal, and later clips shifting isn't a change", () => {
		const current = edit({
			clips: [
				videoClip({ id: "a", start: 0, duration: 4, trimStart: 0 }),
				videoClip({ id: "c", start: 4, duration: 5, trimStart: 20 }),
			],
		});
		const { changes, passages } = compareEdits({ approved, current });
		expect(changes).toEqual([
			{
				kind: "removed",
				what: "clip",
				label: expect.any(String),
				evidence: expect.any(String),
				start: 4,
				end: 4,
				approvedStart: 4,
				approvedEnd: 7,
			},
		]);
		expect(passages).toHaveLength(1);
	});

	test("a trim is a change on both edits, and a new gap is reported", () => {
		const current = edit({
			clips: [
				videoClip({ id: "a", start: 0, duration: 3, trimStart: 0 }),
				videoClip({ id: "b", start: 3, duration: 3, trimStart: 10 }),
				videoClip({ id: "c", start: 8, duration: 5, trimStart: 20 }),
			],
		});
		const { changes } = compareEdits({ approved, current });
		expect(
			changes.map(({ kind, start, end, approvedStart, approvedEnd }) => [
				kind,
				start,
				end,
				approvedStart,
				approvedEnd,
			]),
		).toEqual([
			["changed", 0, 3, 0, 4],
			["gap", 6, 8, 7, 7],
		]);
	});

	test("reports a gap even when the clip before it was trimmed", () => {
		const current = edit({
			clips: [
				videoClip({ id: "a", start: 0, duration: 3, trimStart: 0 }),
				videoClip({ id: "b", start: 10, duration: 3, trimStart: 10 }),
				videoClip({ id: "c", start: 13, duration: 5, trimStart: 20 }),
			],
		});
		const { changes } = compareEdits({ approved, current });
		expect(changes).toContainEqual(
			expect.objectContaining({ kind: "gap", start: 3, end: 10 }),
		);
	});

	test("changed caption text and markers are listed with the clips", () => {
		const cues = [
			{ start: 0, end: 2, text: "Open the menu." },
			{ start: 2, end: 4, text: "Then click save." },
		];
		const before = { ...approved, cues };
		const current = {
			...approved,
			cues: [cues[0], { ...cues[1], text: "Then click Save." }],
			markers: [{ time: s(5), note: "Review the zoom" }] satisfies Marker[],
		};
		const { changes } = compareEdits({ approved: before, current });
		expect(changes.map(({ kind, what, label }) => [kind, what, label])).toEqual(
			[
				["added", "marker", "Review the zoom"],
				["changed", "caption", "Then click Save."],
			],
		);
	});
});

describe("alignLists", () => {
	test("matches the longest common subsequence", () => {
		const pairs = alignLists({
			before: [..."abcdef"],
			after: [..."axcdyf"],
			equals: (a, b) => a === b,
		});
		expect(pairs).toEqual([
			[0, 0],
			[2, 2],
			[3, 3],
			[5, 5],
		]);
	});
});
