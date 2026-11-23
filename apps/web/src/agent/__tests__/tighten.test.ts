import { beforeEach, describe, expect, test } from "bun:test";
import type { EditOp } from "@splice/bridge/ops";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor } from "@/agent/__tests__/fixtures";
import {
	closeSlivers,
	countOverlapping,
	measureSpans,
	planTightenCuts,
} from "@/agent/tighten";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/clip/toggle-source-audio-separation";
import type { EditorCore } from "@/core";
import type { TimelineClip } from "@/timeline";
import { type MediaTime, mediaTimeToSeconds } from "@/wasm";

const first = "recording-1";
const second = "recording-2";
const at = ([projectItemId, sourceIn, sourceOut]: [
	string,
	number,
	number,
]) => ({
	projectItemId,
	sourceIn,
	sourceOut,
});

describe("planTightenCuts", () => {
	const plan = (ranges: Partial<Parameters<typeof planTightenCuts>[0]>) =>
		planTightenCuts({
			pauses: [],
			falseStarts: [],
			fillerWords: [],
			paddingSeconds: 0.2,
			...ranges,
		}).map(({ projectItemId, sourceIn, sourceOut }) => [
			projectItemId,
			Number(sourceIn.toFixed(3)),
			Number(sourceOut.toFixed(3)),
		]);

	test("keeps the breath padding on both sides of a pause and drops pauses too short to cut", () => {
		expect(
			plan({
				pauses: [at([first, 2, 4]), at([first, 5, 5.35]), at([second, 0, 1])],
			}),
		).toEqual([
			[first, 2.2, 3.8],
			[second, 0.2, 0.8],
		]);
		expect(plan({ pauses: [at([first, 2, 4])], paddingSeconds: 0 })).toEqual([
			[first, 2, 4],
		]);
	});

	test("snaps false start and filler edges that fall inside a pause to that pause", () => {
		expect(
			plan({
				pauses: [at([first, 5, 6.1]), at([first, 7.3, 7.8])],
				falseStarts: [at([first, 6, 7.5])],
			}),
		).toEqual([[first, 5.2, 7.6]]);
		// Speech on both sides: the cut is exactly the planned range.
		expect(plan({ falseStarts: [at([first, 6, 7.5])] })).toEqual([
			[first, 6, 7.5],
		]);
		// A filler between two pauses becomes one cut with breath on each side.
		expect(
			plan({
				pauses: [at([second, 8.5, 9]), at([second, 9.3, 10])],
				fillerWords: [at([second, 9, 9.3])],
			}),
		).toEqual([[second, 8.7, 9.8]]);
		// A filler followed by speech is cut up to the next word.
		expect(
			plan({
				pauses: [at([second, 8.5, 9])],
				fillerWords: [at([second, 8.95, 9.3])],
			}),
		).toEqual([[second, 8.7, 9.3]]);
	});

	test("keeps breath only from each pause, so padding never swallows the speech between two", () => {
		expect(
			plan({
				pauses: [at([first, 2, 2.6]), at([first, 2.9, 3.5])],
				falseStarts: [at([first, 2.5, 3])],
				paddingSeconds: 1,
			}),
		).toEqual([[first, 2.6, 2.9]]);
		// A pause shorter than the padding is kept whole beside a false start.
		expect(
			plan({
				pauses: [at([first, 2, 2.15])],
				falseStarts: [at([first, 2.1, 4])],
			}),
		).toEqual([[first, 2.15, 4]]);
	});
});

describe("closeSlivers", () => {
	test("joins gaps between cuts and clip pieces shorter than the minimum", () => {
		expect(
			closeSlivers({
				cuts: [
					{ start: 0.03, end: 1 },
					{ start: 8, end: 14 },
					{ start: 14.04, end: 15 },
					{ start: 16, end: 17 },
					{ start: 17.9, end: 18 },
				],
				edges: [0, 12, 18.05, 24],
				minimum: 2 / 30,
			}),
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 8, end: 15 },
			{ start: 16, end: 17 },
			{ start: 17.9, end: 18.05 },
		]);
	});

	test("measures each moment once", () => {
		expect(
			measureSpans({
				spans: [
					{ start: 0, end: 4 },
					{ start: 2, end: 6 },
				],
				within: [{ start: 1, end: 10 }],
				without: [{ start: 3, end: 4 }],
			}),
		).toBe(4);
	});
});

describe("span measures match a direct count", () => {
	// A small deterministic generator, so a failure reproduces.
	let seed = 7;
	const random = () => {
		seed = (seed * 48271) % 2147483647;
		return seed / 2147483647;
	};
	const spans = (count: number) =>
		Array.from({ length: count }, () => {
			const start = Math.round(random() * 1000) / 10;
			return { start, end: start + Math.round(random() * 50) / 10 };
		});
	const inside = ({
		at,
		list,
	}: {
		at: number;
		list: Array<{ start: number; end: number }>;
	}) => list.some(({ start, end }) => start <= at && at < end);
	/** Length on a 0.01 s grid, which every generated edge lies on. */
	const direct = ({
		measured,
		within,
		without,
	}: Record<
		"measured" | "within" | "without",
		Array<{ start: number; end: number }>
	>) => {
		let total = 0;
		for (let step = 0; step < 11000; step++) {
			const at = step / 100 + 0.005;
			if (
				inside({ at, list: measured }) &&
				inside({ at, list: within }) &&
				!inside({ at, list: without })
			)
				total += 0.01;
		}
		return total;
	};

	test.each(Array.from({ length: 20 }, (_, index) => index))(
		"random case %i",
		() => {
			const measured = spans(6);
			const within = spans(4);
			const without = spans(4);
			expect(measureSpans({ spans: measured, within, without })).toBeCloseTo(
				direct({ measured, within, without }),
				6,
			);
			const groups = [spans(1), spans(2), spans(1), spans(3)];
			expect(countOverlapping({ groups, within, without })).toBe(
				groups.filter(
					(group) => direct({ measured: group, within, without }) > 0,
				).length,
			);
			const edges = spans(5).map(({ start }) => start);
			const cuts = spans(5);
			const naive = cuts
				.sort((a, b) => a.start - b.start)
				.map((cut) => ({ ...cut }));
			expect(closeSlivers({ cuts, edges, minimum: 0.5 })).toEqual(
				closeSliversDirect({ cuts: naive, edges, minimum: 0.5 }),
			);
		},
	);

	test("counts 10,000 pauses in well under a second", () => {
		const pauses = Array.from({ length: 10_000 }, (_, index) => ({
			start: index * 3,
			end: index * 3 + 1,
		}));
		const started = performance.now();
		expect(
			countOverlapping({
				groups: pauses.map((pause) => [pause]),
				within: pauses,
				without: pauses.filter((_, index) => index % 2),
			}),
		).toBe(5_000);
		expect(measureSpans({ spans: pauses, within: pauses })).toBe(10_000);
		expect(
			closeSlivers({
				cuts: pauses,
				edges: pauses.map(({ end }) => end + 0.01),
				minimum: 0.05,
			}),
		).toHaveLength(10_000);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

/** closeSlivers as first written: a linear search for each cut's neighboring edges. */
function closeSliversDirect({
	cuts,
	edges,
	minimum,
}: {
	cuts: Array<{ start: number; end: number }>;
	edges: number[];
	minimum: number;
}) {
	const sorted = [...new Set(edges)].sort((a, b) => a - b);
	const union: Array<{ start: number; end: number }> = [];
	for (const cut of cuts) {
		const last = union.at(-1);
		if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
		else if (cut.end > cut.start) union.push({ ...cut });
	}
	const widened = union
		.map((cut) => {
			const previous = sorted.findLast((edge) => edge < cut.start);
			const next = sorted.find((edge) => edge > cut.end);
			return {
				start:
					previous !== undefined && cut.start - previous < minimum
						? previous
						: cut.start,
				end: next !== undefined && next - cut.end < minimum ? next : cut.end,
			};
		})
		.sort((a, b) => a.start - b.start);
	const joined: Array<{ start: number; end: number }> = [];
	for (const cut of widened) {
		const last = joined.at(-1);
		if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
		else joined.push({ ...cut });
	}
	const closed: Array<{ start: number; end: number }> = [];
	for (const cut of joined) {
		const last = closed.at(-1);
		if (last && cut.start - last.end < minimum) last.end = cut.end;
		else closed.push(cut);
	}
	return closed;
}

let editor: EditorCore;
let api: EditorApi;

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	editor.media.setProjectItems({
		projectItems: [first, second].map((id) => ({
			id,
			name: id,
			type: "video",
			duration: 12,
			hasAudio: true,
			file: new File([], id),
		})),
	});
	api = new EditorApi(editor);
	expect(
		api.rawSequence({
			projectItemIds: [first, second],
			expectedRevision: api.getRevision(),
		}),
	).toMatchObject({ ok: true });
});

const active = () => editor.sequences.getActiveSequence();
const apply = (op: EditOp) =>
	api.apply({
		sequenceId: active().id,
		expectedRevision: api.getRevision(),
		label: "Edit",
		ops: [op],
	});
const round = (time: MediaTime) =>
	Number(mediaTimeToSeconds({ time }).toFixed(3));
const layout = (clips: TimelineClip[]) =>
	clips.map((clip) => [
		"mediaId" in clip ? clip.mediaId : null,
		round(clip.startTime),
		round(clip.duration),
		round(clip.trimStart),
	]);

const badTake = {
	ranges: [at([first, 8, 12]), at([second, 0, 2])],
};
const bestTake = at([second, 4, 8]);
const plan = {
	sections: [{ name: "Filter", takes: [badTake, bestTake], bestTakeIndex: 1 }],
	pauses: [
		at([first, 2, 4]),
		at([first, 4.5, 5.5]),
		at([first, 7.3, 7.8]),
		at([second, 8.5, 9]),
		at([second, 9.3, 10]),
	],
	falseStarts: [
		at([first, 0.03, 1]),
		at([first, 6.2, 7.5]),
		at([second, 2.04, 3]),
	],
	fillerWords: [at([second, 9, 9.3])],
};
const tightenedLayout = [
	[first, 0, 1.2, 1],
	[first, 1.2, 0.9, 3.8],
	[first, 2.1, 0.9, 5.3],
	[first, 3, 0.4, 7.6],
	[second, 3.4, 5.7, 3],
	[second, 9.1, 2.2, 9.8],
];

test("removes pauses, false starts and fillers across a razor and two files in one undo step", () => {
	expect(apply({ op: "razor", at: { seconds: 5 } })).toMatchObject({
		ok: true,
	});
	const raw = active();
	const snapshot = structuredClone(raw);
	const revision = api.getRevision();
	const result = api.roughCut({ ...plan, expectedRevision: revision });
	expect(result).toMatchObject({
		ok: true,
		revision: revision + 1,
		sections: [{ sectionName: "Filter", removedSeconds: 6 }],
		tightening: {
			pausePaddingSeconds: 0.2,
			pauses: { count: 5 },
			falseStarts: { count: 3 },
			fillerWords: { count: 1, removedSeconds: 0.3 },
		},
	});
	if (!result.ok || !("tightening" in result)) throw new Error("No cut");
	expect(result.durationSeconds).toBeCloseTo(11.3, 3);
	const { tightening } = result;
	expect(tightening.pauses.removedSeconds).toBeCloseTo(3.1, 3);
	expect(tightening.falseStarts.removedSeconds).toBeCloseTo(3.23, 3);
	expect(tightening.sliverSeconds).toBeCloseTo(0.07, 3);
	expect(tightening.removedSeconds).toBeCloseTo(6.7, 3);

	const rough = active();
	expect(layout(rough.tracks.main.clips)).toEqual(tightenedLayout);
	// Only take removal leaves a marker.
	expect(rough.markers).toHaveLength(1);
	expect(round(rough.markers[0].time)).toBe(3.4);
	expect(
		editor.sequences.getSequences().find(({ id }) => id === raw.id),
	).toEqual(snapshot);

	editor.command.undo();
	expect(active()).toBe(raw);
	expect(editor.sequences.getSequences()).not.toContain(rough);
	// The next undo is the razor before the cut, so the cut was one step.
	editor.command.undo();
	expect(active().tracks.main.clips).toHaveLength(2);
	editor.command.redo();
	editor.command.redo();
	expect(active().id).toBe(rough.id);
});

test("keeps separated audio linked to the video when tightening across two files", () => {
	const { tracks } = active();
	for (const clip of tracks.main.clips)
		editor.command.execute({
			command: new ToggleSourceAudioSeparationCommand({
				trackId: tracks.main.id,
				clipId: clip.id,
			}),
		});
	const result = api.roughCut({
		expectedRevision: api.getRevision(),
		pauses: [at([first, 11, 12.004]), at([second, 0, 0.5])],
		falseStarts: [at([second, 3, 4])],
	});
	expect(result).toMatchObject({ ok: true, sections: [] });
	const video = layout(active().tracks.main.clips);
	expect(video).toEqual([
		[first, 0, 11.2, 0],
		[first, 11.2, 0.2, 11.8],
		[second, 11.4, 0.2, 0],
		[second, 11.6, 2.7, 0.3],
		[second, 14.3, 8, 4],
	]);
	expect(layout(active().tracks.audio.flatMap(({ clips }) => clips))).toEqual(
		video,
	);
});

test("Restore and Swap still work on a tightened Rough Cut", () => {
	expect(
		api.roughCut({ ...plan, expectedRevision: api.getRevision() }),
	).toMatchObject({ ok: true });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");

	expect(apply({ op: "restore_takes", markerId })).toMatchObject({ ok: true });
	expect(layout(active().tracks.main.clips)).toEqual([
		...tightenedLayout.slice(0, 4),
		[first, 3.4, 4, 8],
		[second, 7.4, 2, 0],
		[second, 9.4, 5.7, 3],
		[second, 15.1, 2.2, 9.8],
	]);
	editor.command.undo();
	expect(layout(active().tracks.main.clips)).toEqual(tightenedLayout);

	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	// The tightened best take (source 4–8 of recording 2) makes way for the bad take.
	expect(layout(active().tracks.main.clips)).toEqual([
		...tightenedLayout.slice(0, 4),
		[second, 3.4, 1, 3],
		[first, 4.4, 4, 8],
		[second, 8.4, 2, 0],
		[second, 10.4, 0.7, 8],
		[second, 11.1, 2.2, 9.8],
	]);
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake, badTakes: [badTake] }],
	});
});

test("swaps a best take spanning two recordings after Tighten cuts one recording's part whole", () => {
	const crossTake = { ranges: [at([first, 9, 12]), at([second, 0, 1])] };
	const result = api.roughCut({
		expectedRevision: api.getRevision(),
		sections: [
			{
				name: "Across files",
				takes: [at([first, 2, 6]), crossTake],
				bestTakeIndex: 1,
			},
		],
		pauses: [],
		falseStarts: [at([second, 0, 1])],
	});
	expect(result).toMatchObject({ ok: true, durationSeconds: 19 });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");
	expect(layout(active().tracks.main.clips)).toEqual([
		[first, 0, 2, 0],
		[first, 2, 6, 6],
		[second, 8, 11, 1],
	]);

	// Only first 9–12 survives of the best take; take 1 replaces it.
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(layout(active().tracks.main.clips)).toEqual([
		[first, 0, 2, 0],
		[first, 2, 3, 6],
		[first, 5, 4, 2],
		[second, 9, 11, 1],
	]);
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake: at([first, 2, 6]), badTakes: [crossTake] }],
	});
	// Swapping back brings the whole stored take, both recordings.
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(layout(active().tracks.main.clips)).toEqual([
		[first, 0, 2, 0],
		[first, 2, 3, 6],
		[first, 5, 3, 9],
		[second, 8, 1, 0],
		[second, 9, 11, 1],
	]);
});

test("tightens and summarizes 10,000 pauses without stalling", () => {
	const long = setUpEditor({ tracks: {} });
	long.media.setProjectItems({
		projectItems: [
			{
				id: first,
				name: first,
				type: "audio",
				duration: 30_000,
				file: new File([], first),
			},
		],
	});
	const longApi = new EditorApi(long);
	expect(
		longApi.rawSequence({
			projectItemIds: [first],
			expectedRevision: longApi.getRevision(),
		}),
	).toMatchObject({ ok: true });
	const pauses = Array.from({ length: 10_000 }, (_, index) =>
		at([first, index * 3, index * 3 + 1]),
	);
	const started = performance.now();
	const result = longApi.roughCut({
		expectedRevision: longApi.getRevision(),
		pauses,
		pausePaddingSeconds: 0,
	});
	const elapsed = performance.now() - started;
	expect(result).toMatchObject({
		ok: true,
		durationSeconds: 20_000,
		tightening: { pauses: { count: 10_000, removedSeconds: 10_000 } },
	});
	console.log(`Tighten with 10,000 pauses: ${Math.round(elapsed)} ms`);
	expect(elapsed).toBeLessThan(3_000);
});

test("rejects a false start that isn't on the source sequence and reports sources", () => {
	const revision = api.getRevision();
	expect(
		api.roughCut({
			expectedRevision: revision,
			falseStarts: [at(["elsewhere", 1, 2])],
		}),
	).toMatchObject({
		ok: false,
		code: "INVALID_OP",
		message: expect.stringContaining("False start 1"),
	});
	expect(api.getRevision()).toBe(revision);
	expect(api.roughCutSources({})).toEqual({
		ok: true,
		sequenceId: active().id,
		items: [
			{ id: first, name: first, path: null },
			{ id: second, name: second, path: null },
		],
	});
	expect(api.roughCutSources({ sequenceId: "missing" })).toMatchObject({
		ok: false,
		message: expect.stringContaining("Unknown source sequence"),
	});
});
