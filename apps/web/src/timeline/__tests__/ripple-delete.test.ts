import { describe, expect, test } from "bun:test";
import { audioClip, s, videoClip } from "@/agent/__tests__/fixtures";
import { buildDefaultSequence } from "@/timeline/sequences";
import { normalizeRanges, rippleDeleteRanges } from "@/timeline/ripple-delete";

let nextId = 0;
const generateId = () => `new-${++nextId}`;

function tracksWith(main: ReturnType<typeof videoClip>[]) {
	const { tracks } = buildDefaultSequence({ name: "Main sequence", isMain: true });
	return { ...tracks, main: { ...tracks.main, clips: main } };
}

describe("rippleDeleteRanges", () => {
	test("removes a range from the middle of a clip and closes the gap", () => {
		const result = rippleDeleteRanges({
			tracks: tracksWith([videoClip({ id: "c1", start: 0, duration: 10 })]),
			markers: [],
			ranges: [{ start: s(2), end: s(4) }],
			generateId,
		});
		const [left, right] = result.tracks.main.clips;
		expect(result.tracks.main.clips).toHaveLength(2);
		expect(left).toMatchObject({ id: "c1", startTime: s(0), duration: s(2), trimStart: s(0), trimEnd: s(8) });
		// The right piece plays source 4–10 and now starts where the cut began.
		expect(right).toMatchObject({ startTime: s(2), duration: s(6), trimStart: s(4), trimEnd: s(0) });
	});

	test("keeps the clip id when only the start of a clip is removed", () => {
		const result = rippleDeleteRanges({
			tracks: tracksWith([videoClip({ id: "c1", start: 0, duration: 10 })]),
			markers: [],
			ranges: [{ start: s(0), end: s(3) }],
			generateId,
		});
		expect(result.tracks.main.clips).toEqual([
			expect.objectContaining({ id: "c1", startTime: s(0), duration: s(7), trimStart: s(3) }),
		]);
	});

	test("drops clips inside the range and shifts later clips and markers", () => {
		const result = rippleDeleteRanges({
			tracks: tracksWith([
				videoClip({ id: "a", start: 0, duration: 2 }),
				videoClip({ id: "b", start: 2, duration: 3 }),
				videoClip({ id: "c", start: 5, duration: 4 }),
			]),
			markers: [{ time: s(1) }, { time: s(3) }, { time: s(6), note: "keep" }],
			ranges: [{ start: s(2), end: s(5) }],
			generateId,
		});
		expect(result.tracks.main.clips.map((clip) => [clip.id, clip.startTime])).toEqual([
			["a", s(0)],
			["c", s(2)],
		]);
		expect(result.markers).toEqual([{ time: s(1) }, { time: s(3), note: "keep" }]);
	});

	test("applies several ranges in original coordinates, on every track", () => {
		const { tracks } = buildDefaultSequence({ name: "Main sequence", isMain: true });
		const result = rippleDeleteRanges({
			tracks: {
				...tracks,
				main: { ...tracks.main, clips: [videoClip({ id: "v", start: 0, duration: 10 })] },
				audio: [{ id: "a1", name: "A1", type: "audio", muted: false, clips: [audioClip({ id: "m", start: 0, duration: 10 })] }],
			},
			markers: [],
			ranges: [
				{ start: s(6), end: s(7) },
				{ start: s(1), end: s(2) },
			],
			generateId,
		});
		const spans = (clips: { startTime: number; duration: number }[]) =>
			clips.map((clip) => [clip.startTime, clip.duration]);
		const expected = [
			[s(0), s(1)],
			[s(1), s(4)],
			[s(5), s(3)],
		];
		expect(spans(result.tracks.main.clips)).toEqual(expected);
		expect(spans(result.tracks.audio[0].clips)).toEqual(expected);
	});
});

describe("normalizeRanges", () => {
	test("sorts, merges overlapping or touching ranges and drops empty ones", () => {
		expect(
			normalizeRanges({
				ranges: [
					{ start: s(5), end: s(6) },
					{ start: s(1), end: s(3) },
					{ start: s(2), end: s(4) },
					{ start: s(4), end: s(4.5) },
					{ start: s(8), end: s(8) },
				],
			}),
		).toEqual([
			{ start: s(1), end: s(4.5) },
			{ start: s(5), end: s(6) },
		]);
	});
});
