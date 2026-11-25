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
import {
	buildClipFromMedia,
	buildLibraryAudioClip,
} from "@/timeline/clip-utils";
import { buildEmptyTrack } from "@/timeline/placement";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";

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
				clips: [
					{ start: 0, end: 12 },
					{ start: 12, end: 18.05 },
					{ start: 18.05, end: 24 },
				],
				minimum: 2 / 30,
			}),
		).toEqual([
			{ start: 0, end: 1 },
			{ start: 8, end: 15 },
			{ start: 16, end: 17 },
			{ start: 17.9, end: 18.05 },
		]);
	});

	test("widens past every clip it would leave a sliver of, not just the nearest boundary", () => {
		// Main starts 30 ms before an overlay; the cut starts 20 ms after the
		// overlay. Widening only to the overlay would leave 30 ms of Main.
		expect(
			closeSlivers({
				cuts: [{ start: 10, end: 11 }],
				clips: [
					{ start: 9.95, end: 20 },
					{ start: 9.98, end: 20 },
					{ start: 0, end: 11.02 },
					{ start: 0, end: 11.05 },
				],
				minimum: 2 / 30,
			}),
		).toEqual([{ start: 9.95, end: 11.05 }]);
		// A clip boundary far from the cut stays where it is.
		expect(
			closeSlivers({
				cuts: [{ start: 10, end: 11 }],
				clips: [
					{ start: 9.5, end: 20 },
					{ start: 9.98, end: 20 },
				],
				minimum: 2 / 30,
			}),
		).toEqual([{ start: 9.98, end: 11 }]);
	});

	test("leaves a short clip that only touches a cut", () => {
		expect(
			closeSlivers({
				cuts: [{ start: 10, end: 11 }],
				clips: [
					{ start: 0, end: 9.95 },
					{ start: 9.95, end: 10 },
					{ start: 10, end: 11 },
					{ start: 11, end: 11.05 },
					{ start: 11.05, end: 20 },
				],
				minimum: 2 / 30,
			}),
		).toEqual([{ start: 10, end: 11 }]);
		// The remnants of a clip the cut crosses still close.
		expect(
			closeSlivers({
				cuts: [{ start: 10, end: 11 }],
				clips: [
					{ start: 9.95, end: 10.5 },
					{ start: 10.5, end: 11.05 },
				],
				minimum: 2 / 30,
			}),
		).toEqual([{ start: 9.95, end: 11.05 }]);
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
			const clips = spans(8);
			const cuts = spans(5);
			const naive = cuts
				.sort((a, b) => a.start - b.start)
				.map((cut) => ({ ...cut }));
			// Off the 0.1 s grid, so float error never decides a comparison.
			const minimum = 0.45;
			expect(closeSlivers({ cuts, clips, minimum })).toEqual(
				closeSliversDirect({ cuts: naive, clips, minimum }),
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
				clips: pauses.map(({ start, end }) => ({
					start: start - 0.5,
					end: end + 0.01,
				})),
				minimum: 0.05,
			}),
		).toHaveLength(10_000);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

/** closeSlivers checked directly: every clip against every cut edge until nothing moves. */
function closeSliversDirect({
	cuts,
	clips,
	minimum,
}: {
	cuts: Array<{ start: number; end: number }>;
	clips: Array<{ start: number; end: number }>;
	minimum: number;
}) {
	const union: Array<{ start: number; end: number }> = [];
	for (const cut of cuts) {
		const last = union.at(-1);
		if (last && cut.start <= last.end) last.end = Math.max(last.end, cut.end);
		else if (cut.end > cut.start) union.push({ ...cut });
	}
	const widened = union
		.map((cut) => {
			let { start, end } = cut;
			for (let moved = true; moved; ) {
				moved = false;
				for (const clip of clips) {
					if (
						clip.start < start &&
						clip.end >= start &&
						start - clip.start < minimum
					) {
						start = clip.start;
						moved = true;
					}
					if (clip.end > end && clip.start <= end && clip.end - end < minimum) {
						end = clip.end;
						moved = true;
					}
				}
			}
			return { start, end };
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

test("counts a pause only when it is credited with removed seconds", () => {
	// The 50 ms pause is shorter than its padding, so it plans no cut; closing
	// the sliver before the false start removes it, and that time is a sliver.
	const result = api.roughCut({
		expectedRevision: api.getRevision(),
		pauses: [at([first, 0, 0.05])],
		falseStarts: [at([first, 0.05, 1])],
	});
	expect(result).toMatchObject({
		ok: true,
		tightening: {
			pauses: { count: 0, removedSeconds: 0 },
			falseStarts: { count: 1 },
		},
	});
	if (!result.ok || !("tightening" in result)) throw new Error("No cut");
	expect(result.tightening.sliverSeconds).toBeCloseTo(0.05, 3);
	expect(result.durationSeconds).toBeCloseTo(23, 3);
});

test("keeps a sound shorter than a sliver between two pauses", () => {
	// 40 ms of sound between the pauses is under two frames at 30 fps.
	const result = api.roughCut({
		expectedRevision: api.getRevision(),
		pauses: [at([first, 2, 3]), at([first, 3.04, 4])],
		pausePaddingSeconds: 0,
	});
	expect(result).toMatchObject({
		ok: true,
		tightening: { pauses: { count: 2 }, sliverSeconds: 0 },
	});
	if (!result.ok || !("tightening" in result)) throw new Error("No cut");
	expect(result.tightening.pauses.removedSeconds).toBeCloseTo(1.96, 3);
	expect(result.durationSeconds).toBeCloseTo(22.04, 3);
	expect(layout(active().tracks.main.clips)).toEqual([
		[first, 0, 2, 0],
		[first, 2, 0.04, 3],
		[first, 2.04, 8, 4],
		[second, 10.04, 12, 0],
	]);
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

describe("pauses follow what plays", () => {
	const scratch = "scratch";
	/** A scratch recording under Main's first 12 s, on its own audio track. */
	const addScratch = ({
		muted,
		missing = false,
	}: {
		muted: boolean;
		missing?: boolean;
	}) => {
		editor.media.setProjectItems({
			projectItems: [
				...editor.media.getProjectItems(),
				{
					id: scratch,
					name: scratch,
					type: "audio",
					duration: 12,
					file: new File([], scratch),
					missing,
				},
			],
		});
		const clip = buildClipFromMedia({
			mediaId: scratch,
			mediaType: "audio",
			name: scratch,
			duration: mediaTimeFromSeconds({ seconds: 12 }),
			startTime: ZERO_MEDIA_TIME,
		});
		if (clip.type !== "audio") throw new Error("Not an audio clip");
		const { tracks } = active();
		editor.timeline.updateTracks({
			...tracks,
			audio: [
				...tracks.audio,
				{
					...buildEmptyTrack({ id: "scratch-track", type: "audio" }),
					muted,
					clips: [{ ...clip, id: "scratch-clip" }],
				},
			],
		});
	};
	const cut = (pauses: ReturnType<typeof at>[]) =>
		api.roughCut({ expectedRevision: api.getRevision(), pauses });

	test("ignores a muted track's silence under continuous audio", () => {
		addScratch({ muted: true });
		expect(api.roughCutSources({})).toMatchObject({
			items: [{ id: first }, { id: second }],
		});
		// Main plays on; only the muted scratch track is silent.
		expect(cut([at([scratch, 2.22, 3.817])])).toMatchObject({
			ok: true,
			durationSeconds: 24,
			tightening: { pauses: { count: 0, removedSeconds: 0 } },
		});
	});

	test("ignores a muted track's sound over a pause", () => {
		addScratch({ muted: true });
		const result = cut([at([first, 2, 4.5])]);
		expect(result).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 1 } },
		});
		if (!result.ok || !("tightening" in result)) throw new Error("No cut");
		expect(result.tightening.pauses.removedSeconds).toBeCloseTo(2.1, 3);
		expect(result.durationSeconds).toBeCloseTo(21.9, 3);
	});

	test("cuts only where every recording heard there is silent", () => {
		addScratch({ muted: false });
		expect(api.roughCutSources({})).toMatchObject({
			items: [{ id: first }, { id: second }, { id: scratch }],
		});
		// The scratch recording sounds through Main's pause.
		expect(cut([at([first, 2, 4.5])])).toMatchObject({
			ok: true,
			durationSeconds: 24,
			tightening: { pauses: { count: 0 } },
		});
		// Both are silent from 2.22 to 3.817 s: only that, less the padding, goes.
		const result = cut([at([first, 2, 4.5]), at([scratch, 2.22, 3.817])]);
		expect(result).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 2 } },
		});
		if (!result.ok || !("tightening" in result)) throw new Error("No cut");
		expect(result.tightening.pauses.removedSeconds).toBeCloseTo(1.197, 3);
		expect(result.durationSeconds).toBeCloseTo(22.803, 3);
	});

	test("skips a missing recording, which playback skips too", () => {
		addScratch({ muted: false, missing: true });
		expect(api.roughCutSources({})).toMatchObject({
			items: [{ id: first }, { id: second }],
		});
		// The missing scratch clip neither blocks Main's pause nor is scanned.
		const result = cut([at([first, 2, 4.5])]);
		expect(result).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 1 } },
		});
		if (!result.ok || !("tightening" in result)) throw new Error("No cut");
		expect(result.tightening.pauses.removedSeconds).toBeCloseTo(2.1, 3);
		// Loudness still lists it, so the report says it was skipped.
		expect(api.audioSources({})).toMatchObject({
			ok: true,
			audioSources: expect.arrayContaining([
				expect.objectContaining({ projectItemId: scratch, missing: true }),
			]),
		});
	});

	test("keeps a pause under library music, which can't be scanned", () => {
		const music = buildLibraryAudioClip({
			sourceUrl: "https://example.com/music.mp3",
			name: "Music",
			duration: mediaTimeFromSeconds({ seconds: 10 }),
			startTime: ZERO_MEDIA_TIME,
		});
		const { tracks } = active();
		const withMusic = (muted: boolean) =>
			editor.timeline.updateTracks({
				...tracks,
				audio: [
					...tracks.audio,
					{
						...buildEmptyTrack({ id: "music-track", type: "audio" }),
						muted,
						clips: [{ ...music, id: "music-clip" }],
					},
				],
			});
		withMusic(false);
		expect(cut([at([first, 2, 4.5])])).toMatchObject({
			ok: true,
			durationSeconds: 24,
			tightening: { pauses: { count: 0, removedSeconds: 0 } },
		});
		// Muted music doesn't play, so the pause goes.
		editor.command.undo();
		withMusic(true);
		const result = cut([at([first, 2, 4.5])]);
		expect(result).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 1 } },
		});
		if (!result.ok || !("tightening" in result)) throw new Error("No cut");
		expect(result.tightening.pauses.removedSeconds).toBeCloseTo(2.1, 3);
	});

	const seconds = (value: number) => mediaTimeFromSeconds({ seconds: value });
	/**
	 * The first recording's opening 6 s plays again at 24 s, under the scratch
	 * recording.
	 */
	const repeatUnderScratch = () => {
		const repeat = buildClipFromMedia({
			mediaId: first,
			mediaType: "video",
			name: first,
			duration: seconds(12),
			startTime: seconds(24),
		});
		if (repeat.type !== "video") throw new Error("Not a video clip");
		const { tracks } = active();
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					...tracks.main.clips,
					{
						...repeat,
						id: "repeat-clip",
						duration: seconds(6),
						trimEnd: seconds(6),
					},
				],
			},
		});
		addScratch({ muted: false });
		const { tracks: withScratch } = active();
		editor.timeline.updateTracks({
			...withScratch,
			audio: withScratch.audio.map((track) => ({
				...track,
				clips: track.clips.map((clip) =>
					clip.id === "scratch-clip"
						? { ...clip, startTime: seconds(24), duration: seconds(6) }
						: clip,
				),
			})),
		});
	};

	test("pads a pause from its own silence at each placement", () => {
		repeatUnderScratch();
		// The pause is silent throughout at 2 s, but at the repeat only from
		// source 3 s, where the scratch recording goes quiet. Each cut keeps
		// 0.2 s of its own silence.
		const result = cut([at([first, 2, 4.5]), at([scratch, 3, 6])]);
		expect(result).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 2 } },
		});
		if (!result.ok || !("tightening" in result)) throw new Error("No cut");
		expect(result.tightening.pauses.removedSeconds).toBeCloseTo(3.2, 3);
		expect(result.durationSeconds).toBeCloseTo(26.8, 3);
		expect(
			layout(active().tracks.main.clips).filter(([id]) => id === first),
		).toEqual([
			[first, 0, 2.2, 0],
			[first, 2.2, 7.7, 4.3],
			[first, 21.9, 3.2, 0],
			[first, 25.1, 1.7, 4.3],
		]);
	});

	test("cuts a pause only at the placement where every recording is silent", () => {
		repeatUnderScratch();
		/** How much of the scratch recording the new Rough Cut keeps. */
		const scratchLength = () => {
			const cutSequence = active();
			expect(cutSequence.name).toStartWith("Rough Cut");
			return cutSequence.tracks.audio
				.flatMap((track) => track.clips)
				.filter((clip) => "mediaId" in clip && clip.mediaId === scratch)
				.reduce(
					(sum, clip) => sum + mediaTimeToSeconds({ time: clip.duration }),
					0,
				);
		};
		const pauseOnly = cut([at([first, 2, 4.5])]);
		expect(pauseOnly).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 1 } },
		});
		if (!pauseOnly.ok || !("tightening" in pauseOnly))
			throw new Error("No cut");
		expect(pauseOnly.tightening.pauses.removedSeconds).toBeCloseTo(2.1, 3);
		expect(pauseOnly.durationSeconds).toBeCloseTo(27.9, 3);
		expect(scratchLength()).toBeCloseTo(6, 3);

		// A filler that snaps to the pause takes the pause only where it is
		// silent; at the second placement only the filler goes.
		const withFiller = api.roughCut({
			expectedRevision: api.getRevision(),
			pauses: [at([first, 2, 4.5])],
			fillerWords: [at([first, 4.5, 4.8])],
		});
		expect(withFiller).toMatchObject({
			ok: true,
			tightening: { pauses: { count: 1 }, fillerWords: { count: 1 } },
		});
		if (!withFiller.ok || !("tightening" in withFiller))
			throw new Error("No cut");
		expect(withFiller.tightening.removedSeconds).toBeCloseTo(2.9, 3);
		expect(withFiller.durationSeconds).toBeCloseTo(27.1, 3);
		expect(scratchLength()).toBeCloseTo(5.7, 3);
	});
});

test("preserves teaching order by the first take of each section", () => {
	const source = active();
	const args = {
		expectedRevision: api.getRevision(),
		pauses: [],
		sections: [
			{ name: "Setup", takes: [at([first, 0, 2]), at([first, 8, 10])], bestTakeIndex: 1 },
			{ name: "Payoff", takes: [at([first, 3, 6])], bestTakeIndex: 0 },
		],
	};
	expect(api.roughCut(args)).toMatchObject({
		code: "INVALID_OP",
		message: expect.stringContaining("teaching order"),
	});
	expect(active()).toBe(source);
	expect(api.roughCut({ ...args, restructure: true })).toMatchObject({ ok: true });
});

test("tightening preserves a one-take section and reports a missed brief target", () => {
	editor.save.pause();
	expect(api.briefSet({
		projectId: editor.project.getActive().metadata.id,
		expectedRevision: api.getRevision(),
		brief: { goal: "Show the setup and payoff", targetDurationSeconds: 1 },
	})).toMatchObject({ ok: true });
	const source = active();
	const args = {
		expectedRevision: api.getRevision(),
		pauses: [],
		sections: [{ name: "Payoff", takes: [at([first, 3, 6])], bestTakeIndex: 0 }],
	};
	const falseStarts = [at([first, 3, 4]), at([first, 4, 6])];
	expect(api.roughCut({ ...args, falseStarts, plan: true })).toMatchObject({
		code: "INVALID_OP",
		message: expect.stringContaining("whole “Payoff” section"),
	});
	expect(api.roughCut({ ...args, falseStarts })).toMatchObject({ code: "INVALID_OP" });
	expect(active()).toBe(source);
	expect(api.roughCut({ ...args, plan: true })).toMatchObject({
		ok: true,
		brief: { targetDurationSeconds: 1 },
		targetDuration: { targetSeconds: 1, overBySeconds: 23 },
		targetDurationNote: expect.stringContaining("exceeds"),
	});
	expect(api.roughCut({ ...args, falseStarts, restructure: true })).toMatchObject({
		ok: true,
		durationSeconds: 21,
		brief: { goal: "Show the setup and payoff" },
		targetDuration: { targetSeconds: 1, overBySeconds: 20 },
	});
});
