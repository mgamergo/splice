import { describe, expect, test } from "bun:test";
import { audioClip, s, videoClip } from "@/agent/__tests__/fixtures";
import type { Marker } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";
import { normalizeRanges, rippleDeleteRanges } from "@/timeline/ripple-delete";

let nextId = 0;
const generateId = () => `new-${++nextId}`;

function tracksWith(main: ReturnType<typeof videoClip>[]) {
	const { tracks } = buildDefaultSequence({
		name: "Main sequence",
		isMain: true,
	});
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
		expect(left).toMatchObject({
			id: "c1",
			startTime: s(0),
			duration: s(2),
			trimStart: s(0),
			trimEnd: s(8),
		});
		// The right piece plays source 4–10 and now starts where the cut began.
		expect(right).toMatchObject({
			startTime: s(2),
			duration: s(6),
			trimStart: s(4),
			trimEnd: s(0),
		});
	});

	test("keeps the clip id when only the start of a clip is removed", () => {
		const result = rippleDeleteRanges({
			tracks: tracksWith([videoClip({ id: "c1", start: 0, duration: 10 })]),
			markers: [],
			ranges: [{ start: s(0), end: s(3) }],
			generateId,
		});
		expect(result.tracks.main.clips).toEqual([
			expect.objectContaining({
				id: "c1",
				startTime: s(0),
				duration: s(7),
				trimStart: s(3),
			}),
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
		expect(
			result.tracks.main.clips.map((clip) => [clip.id, clip.startTime]),
		).toEqual([
			["a", s(0)],
			["c", s(2)],
		]);
		expect(result.markers).toEqual([
			{ time: s(1) },
			{ time: s(3), note: "keep" },
		]);
	});

	test("applies several ranges in original coordinates, on every track", () => {
		const { tracks } = buildDefaultSequence({
			name: "Main sequence",
			isMain: true,
		});
		const result = rippleDeleteRanges({
			tracks: {
				...tracks,
				main: {
					...tracks.main,
					clips: [videoClip({ id: "v", start: 0, duration: 10 })],
				},
				audio: [
					{
						id: "a1",
						name: "A1",
						type: "audio",
						muted: false,
						clips: [audioClip({ id: "m", start: 0, duration: 10 })],
					},
				],
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

describe("rippleDeleteRanges in one pass", () => {
	// A small deterministic generator, so a failure reproduces.
	let seed = 11;
	const random = (max: number) => {
		seed = (seed * 48271) % 2147483647;
		return Math.floor((seed / 2147483647) * max);
	};
	const shape = ({
		tracks,
		markers,
	}: ReturnType<typeof rippleDeleteRanges>) => ({
		clips: [tracks.main, ...tracks.audio].map(({ clips }) =>
			clips.map(({ startTime, duration, trimStart, trimEnd }) => [
				startTime,
				duration,
				trimStart,
				trimEnd,
			]),
		),
		markers: markers.map(({ time }) => time),
		ids: tracks.main.clips.map(({ id }) =>
			id.startsWith("new-") ? "new" : id,
		),
	});

	test.each(Array.from({ length: 25 }, (_, index) => index))(
		"matches deleting the ranges one at a time, last first (case %i)",
		() => {
			const { tracks } = buildDefaultSequence({
				name: "Main sequence",
				isMain: true,
			});
			const main = [0, 7, 15, 28].map((start, index) => ({
				...videoClip({
					id: `v${index}`,
					start,
					duration: 4 + random(4),
					trimStart: random(3),
				}),
				...(index === 2 ? { retime: { rate: 1.5 } } : {}),
			}));
			const input = {
				...tracks,
				main: { ...tracks.main, clips: main },
				audio: [
					{
						id: "a1",
						name: "A1",
						type: "audio" as const,
						muted: false,
						clips: [audioClip({ id: "m", start: 1, duration: 30 })],
					},
				],
			};
			const take = { projectItemId: "p", sourceIn: 0, sourceOut: 1 };
			const markers = Array.from({ length: 6 }, (_, index): Marker => {
				const time = s(random(340) / 10);
				return index % 2
					? {
							time,
							id: `marker-${index}`,
							data: {
								kind: "removal",
								sectionName: "Intro",
								bestTake: take,
								badTakes: [take],
							},
						}
					: { time };
			});
			const ranges = Array.from({ length: 6 }, () => {
				const start = random(340) / 10;
				return { start: s(start), end: s(start + 0.5 + random(30) / 10) };
			});
			const once = rippleDeleteRanges({
				tracks: input,
				markers,
				ranges,
				generateId,
			});
			const stepwise = normalizeRanges({ ranges })
				.reverse()
				.reduce<ReturnType<typeof rippleDeleteRanges>>(
					(result, range) =>
						rippleDeleteRanges({ ...result, ranges: [range], generateId }),
					{ tracks: input, markers },
				);
			expect(shape(once)).toEqual(shape(stepwise));
		},
	);

	test("deletes 10,000 ranges from one long clip quickly", () => {
		const ranges = Array.from({ length: 10_000 }, (_, index) => ({
			start: s(index * 3),
			end: s(index * 3 + 1),
		}));
		const started = performance.now();
		const result = rippleDeleteRanges({
			tracks: tracksWith([
				videoClip({ id: "long", start: 0, duration: 30_000 }),
			]),
			markers: [],
			ranges,
			generateId,
		});
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(result.tracks.main.clips).toHaveLength(10_000);
		expect(result.tracks.main.clips.at(-1)).toMatchObject({
			startTime: s(19_998),
			duration: s(2),
		});
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
