import { beforeEach, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import {
	audioClip,
	s,
	setUpEditor,
	videoClip,
} from "@/agent/__tests__/fixtures";
import { applySourceGains, collectAudioSources } from "@/agent/loudness";
import type { ClipAnimations } from "@/animation/types";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/clip/toggle-source-audio-separation";
import type { EditorCore } from "@/core";
import { collectAudioClipSources } from "@/media/audio";
import type { ProjectItem } from "@/media/types";
import type { TimelineClip } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import type { VideoClip } from "@/timeline/types";
import { addMediaTime, mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { removalMarkerDataSchema } from "@splice/bridge/ops";

const first = "recording-1";
const second = "recording-2";
const section = {
	name: "Intro",
	takes: [
		{ projectItemId: first, sourceIn: 0, sourceOut: 4 },
		{ projectItemId: first, sourceIn: 4, sourceOut: 10 },
	],
	bestTakeIndex: 1,
};

function diskItem(id: string): ProjectItem {
	return {
		id,
		name: id,
		type: "video",
		duration: 12,
		hasAudio: true,
		file: {
			kind: "disk",
			path: `Day 1/${id}.mov`,
			url: `/splice/media/Day%201/${id}.mov`,
			name: `${id}.mov`,
			type: "video/quicktime",
			size: 1,
			lastModified: 0,
		},
	};
}

const browserItem: ProjectItem = {
	...diskItem("browser"),
	file: new File([], "browser.mov", { type: "video/quicktime" }),
};

let editor: EditorCore;
let api: EditorApi;

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	editor.media.setProjectItems({
		projectItems: [diskItem(first), diskItem(second), browserItem],
	});
	api = new EditorApi(editor);
	api.rawSequence({
		projectItemIds: [first, second, "browser"],
		expectedRevision: api.getRevision(),
	});
});

const active = () => editor.sequences.getActiveSequence();
const flags = (clips: TimelineClip[] = active().tracks.main.clips) =>
	clips.map((clip) => [
		"mediaId" in clip ? clip.mediaId : null,
		clip.params.noiseReduction ?? false,
	]);

function setNoiseReduction({
	clipIds,
	enabled,
}: {
	clipIds: string[];
	enabled: boolean;
}) {
	return api.apply({
		sequenceId: active().id,
		expectedRevision: api.getRevision(),
		label: "Noise reduction",
		ops: [{ op: "set_noise_reduction", clipIds, enabled }],
	});
}

test("set_noise_reduction flags clips as one undo step and shows in the digest", () => {
	const [a, b] = active().tracks.main.clips.map(({ id }) => id);
	expect(setNoiseReduction({ clipIds: [a, b], enabled: true })).toEqual({
		ok: true,
		revision: expect.any(Number),
		label: "Noise reduction",
		summary: ["turned noise reduction on for 2 clip(s)"],
	});
	expect(flags()).toEqual([
		[first, true],
		[second, true],
		["browser", false],
	]);
	expect(api.getDigest()).toContain("denoised");
	editor.command.undo();
	expect(flags()).toEqual([
		[first, false],
		[second, false],
		["browser", false],
	]);
	expect(api.getDigest()).not.toContain("denoised");
	editor.command.redo();
	expect(flags().filter(([, on]) => on)).toHaveLength(2);
	expect(setNoiseReduction({ clipIds: [a], enabled: false })).toMatchObject({
		ok: true,
	});
	expect(flags()[0]).toEqual([first, false]);
});

test("set_noise_reduction refuses items stored in the browser and unknown clips", () => {
	const browserClip = active().tracks.main.clips[2].id;
	const before = api.getRevision();
	expect(
		setNoiseReduction({ clipIds: [browserClip], enabled: true }),
	).toMatchObject({ ok: false, code: "INVALID_OP" });
	expect(
		setNoiseReduction({ clipIds: ["missing"], enabled: true }),
	).toMatchObject({ ok: false, code: "INVALID_OP" });
	expect(api.getRevision()).toBe(before);
	// Turning it off is always allowed.
	expect(
		setNoiseReduction({ clipIds: [browserClip], enabled: false }),
	).toMatchObject({ ok: true });
});

test("a rough cut with noise reduction plans denoised sources and cuts with flags and gains in one step, leaving Raw untouched", () => {
	const raw = active();
	const rawClips = raw.tracks.main.clips;
	const plan = api.roughCut({
		sections: [section],
		expectedRevision: api.getRevision(),
		plan: true,
		noiseReduction: true,
	});
	expect(plan).toMatchObject({
		ok: true,
		audioSources: [
			{ projectItemId: first, noiseReduction: true },
			{ projectItemId: second, noiseReduction: true },
			// Browser items have no render to play, so stay as they are.
			{ projectItemId: "browser", path: null, noiseReduction: false },
		],
	});
	expect(active()).toBe(raw);

	const result = api.roughCut({
		sections: [section],
		expectedRevision: api.getRevision(),
		noiseReduction: true,
		sourceGains: [
			{ projectItemId: first, noiseReduction: true, gainDb: 3 },
			// For plain clips of the recording, which this cut has none of.
			{ projectItemId: second, gainDb: -9 },
		],
	});
	expect(result).toMatchObject({ ok: true });
	expect(active().name).toBe("Rough Cut");
	expect(flags()).toEqual([
		[first, true],
		[second, true],
		["browser", false],
	]);
	expect(active().tracks.main.clips[0].params.volume).toBe(3);
	expect(active().tracks.main.clips[1].params.volume ?? 0).toBe(0);
	const rawAfter = editor.sequences
		.getSequences()
		.find(({ id }) => id === raw.id);
	expect(rawAfter?.tracks.main.clips).toBe(rawClips);
	expect(flags(rawClips)).toEqual([
		[first, false],
		[second, false],
		["browser", false],
	]);

	editor.command.undo();
	expect(active()).toBe(raw);
	expect(editor.sequences.getSequences().map(({ name }) => name)).not.toContain(
		"Rough Cut",
	);
});

test("a tightened rough cut with noise reduction plans the kept denoised audio and denoises every piece", () => {
	// Cut 6.2–7.8 s of recording-1, keeping 0.2 s of breath on each side.
	const tighten = {
		sections: [section],
		pauses: [{ projectItemId: first, sourceIn: 6, sourceOut: 8 }],
		pausePaddingSeconds: 0.2,
		noiseReduction: true,
	};
	const plan = api.roughCut({
		...tighten,
		expectedRevision: api.getRevision(),
		plan: true,
	});
	expect(plan).toMatchObject({ ok: true });
	const [denoised] = "audioSources" in plan ? (plan.audioSources ?? []) : [];
	if (!denoised) throw new Error("expected a plan with audio sources");
	expect(denoised).toMatchObject({ projectItemId: first, noiseReduction: true });
	// The meter hears what tightening keeps: the pause is gone from the ranges.
	expect(denoised.ranges).toHaveLength(2);
	expect(denoised.ranges[0].start).toBeCloseTo(4, 3);
	expect(denoised.ranges[0].end).toBeCloseTo(6.2, 3);
	expect(denoised.ranges[1].start).toBeCloseTo(7.8, 3);
	expect(denoised.ranges[1].end).toBeCloseTo(12, 3);

	const result = api.roughCut({
		...tighten,
		expectedRevision: api.getRevision(),
		sourceGains: [{ projectItemId: first, noiseReduction: true, gainDb: 3 }],
	});
	expect(result).toMatchObject({
		ok: true,
		tightening: { pauses: { count: 1 } },
	});
	const firstClips = active().tracks.main.clips.filter(
		(clip) => "mediaId" in clip && clip.mediaId === first,
	);
	expect(firstClips).toHaveLength(2);
	for (const clip of firstClips) {
		expect(clip.params.noiseReduction).toBe(true);
		expect(clip.params.volume).toBe(3);
	}
});

test("tightening hears a clip denoised in Raw like any other and keeps its noise reduction on every piece", () => {
	const [a] = active().tracks.main.clips.map(({ id }) => id);
	setNoiseReduction({ clipIds: [a], enabled: true });
	const result = api.roughCut({
		sections: [],
		pauses: [{ projectItemId: first, sourceIn: 6, sourceOut: 8 }],
		pausePaddingSeconds: 0.2,
		expectedRevision: api.getRevision(),
	});
	expect(result).toMatchObject({
		ok: true,
		tightening: { pauses: { count: 1 } },
	});
	expect(flags()).toEqual([
		[first, true],
		[first, true],
		[second, false],
		["browser", false],
	]);
});

test("clips with noise reduction play splice's WAV render, cached apart from the source", async () => {
	const [a, b] = active().tracks.main.clips.map(({ id }) => id);
	setNoiseReduction({ clipIds: [a], enabled: true });
	const { tracks } = active();
	const projectItems = editor.media.getProjectItems();
	const sources = await collectAudioClipSources({ tracks, projectItems });
	const byClip = new Map(sources.map((source) => [source.id, source]));
	expect(byClip.get(a)).toMatchObject({
		sourceKey: `${first}:denoised`,
		file: {
			kind: "disk",
			path: `Day 1/${first}.mov`,
			url: `/splice/media/Day%201/${first}.mov?audio=denoised`,
			type: "audio/wav",
		},
	});
	expect(byClip.get(b)).toMatchObject({
		sourceKey: second,
		file: { url: `/splice/media/Day%201/${second}.mov` },
	});
	// A stale flag on a browser item plays the item as is.
	const browserClip = tracks.main.clips[2];
	const flagged = {
		...tracks,
		main: {
			...tracks.main,
			clips: tracks.main.clips.map((clip) =>
				clip.id === browserClip.id
					? { ...clip, params: { ...clip.params, noiseReduction: true } }
					: clip,
			),
		},
	};
	const browser = (
		await collectAudioClipSources({ tracks: flagged, projectItems })
	).find(({ id }) => id === browserClip.id);
	expect(browser?.sourceKey).toBe("browser");
	expect(browser?.file).toBe(browserItem.file);
	expect(
		collectAudioSources({ tracks: flagged, projectItems }).find(
			({ projectItemId }) => projectItemId === "browser",
		),
	).toMatchObject({ noiseReduction: false });
});

test("clips of one recording with noise reduction on and off are measured apart", () => {
	const clip = active().tracks.main.clips[0];
	const copy = {
		...clip,
		id: "copy",
		startTime: addMediaTime({ a: clip.startTime, b: clip.duration }),
	};
	const tracks = {
		...active().tracks,
		main: {
			...active().tracks.main,
			clips: [
				{ ...clip, params: { ...clip.params, noiseReduction: true } },
				copy,
			],
		},
	};
	expect(
		collectAudioSources({
			tracks,
			projectItems: editor.media.getProjectItems(),
		}),
	).toMatchObject([
		{ projectItemId: first, noiseReduction: true, clipIds: [clip.id] },
		{ projectItemId: first, noiseReduction: false, clipIds: ["copy"] },
	]);
});

test("a recording's denoised and plain clips take their own gains", () => {
	const clip = active().tracks.main.clips[0];
	const copy = {
		...clip,
		id: "copy",
		startTime: addMediaTime({ a: clip.startTime, b: clip.duration }),
	};
	const tracks = applySourceGains({
		tracks: {
			...active().tracks,
			main: {
				...active().tracks.main,
				clips: [
					{ ...clip, params: { ...clip.params, noiseReduction: true } },
					copy,
				],
			},
		},
		projectItems: editor.media.getProjectItems(),
		// The denoised gain is listed last, so a gain keyed by recording alone
		// would set it on both.
		gains: [
			{ projectItemId: first, gainDb: 2 },
			{ projectItemId: first, noiseReduction: true, gainDb: 7 },
		],
	});
	expect(tracks.main.clips.map(({ id, params }) => [id, params.volume])).toEqual(
		[
			[clip.id, 7],
			["copy", 2],
		],
	);
});

test("audioSources can list each recording as it will sound once noise reduction is set", () => {
	const [clip, other, browser] = active().tracks.main.clips;
	// A second clip of the first recording, played where the second one was.
	const copy = { ...clip, id: "copy", startTime: other.startTime };
	editor.timeline.updateTracks({
		...active().tracks,
		main: {
			...active().tracks.main,
			clips: [
				{ ...clip, params: { ...clip.params, noiseReduction: true } },
				copy,
				browser,
			],
		},
	});
	const sources = (noiseReduction?: boolean) => {
		const result = api.audioSources(
			noiseReduction === undefined ? {} : { noiseReduction },
		);
		if (!result.ok) throw new Error("audioSources failed");
		return result.audioSources.map(
			({ projectItemId, noiseReduction, clipIds }) => [
				projectItemId,
				noiseReduction,
				clipIds,
			],
		);
	};
	expect(sources()).toEqual([
		[first, true, [clip.id]],
		[first, false, ["copy"]],
		["browser", false, [browser.id]],
	]);
	// One source per recording, in playing order; browser items stay as they are.
	expect(sources(true)).toEqual([
		[first, true, [clip.id, "copy"]],
		["browser", false, [browser.id]],
	]);
	expect(sources(false)[0]).toEqual([first, false, [clip.id, "copy"]]);
	// Only a listing: the sequence is unchanged.
	expect(flags()).toEqual([
		[first, true],
		[first, false],
		["browser", false],
	]);
});

test("restored and swapped takes keep their recording's noise reduction", () => {
	api.roughCut({
		sections: [section],
		expectedRevision: api.getRevision(),
		noiseReduction: true,
	});
	const [marker] = active().markers;
	const restore = () =>
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Restore",
			ops: [{ op: "restore_takes", markerId: marker.id }],
		});
	expect(restore()).toMatchObject({ ok: true });
	const recordingClips = () =>
		active().tracks.main.clips.filter(
			(clip) => "mediaId" in clip && clip.mediaId === first,
		);
	expect(recordingClips().length).toBeGreaterThan(1);
	for (const clip of recordingClips())
		expect(clip.params.noiseReduction).toBe(true);
	editor.command.undo();

	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Swap",
			ops: [{ op: "swap_take", markerId: marker.id, takeIndex: 0 }],
		}),
	).toMatchObject({ ok: true });
	for (const clip of recordingClips())
		expect(clip.params.noiseReduction).toBe(true);
	editor.command.undo();

	// With it off for the recording, restored takes play the source.
	setNoiseReduction({
		clipIds: recordingClips().map(({ id }) => id),
		enabled: false,
	});
	expect(restore()).toMatchObject({ ok: true });
	for (const clip of recordingClips())
		expect(clip.params.noiseReduction ?? false).toBe(false);
});

test("a take swapped out and back keeps its noise reduction when no other clip of its recording is left", () => {
	const { tracks } = active();
	editor.timeline.updateTracks({
		...tracks,
		main: {
			...tracks.main,
			clips: [
				{
					...videoClip({ id: "best", start: 0, duration: 2, trimStart: 4 }),
					mediaId: first,
				},
			],
		},
		audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
	});
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Marker",
			ops: [
				{
					op: "add_marker",
					at: { seconds: 1 },
					data: {
						kind: "removal",
						sectionName: "Intro",
						bestTake: { projectItemId: first, sourceIn: 4, sourceOut: 6 },
						badTakes: [{ projectItemId: second, sourceIn: 0, sourceOut: 3 }],
					},
				},
				{ op: "set_noise_reduction", clipIds: ["best"], enabled: true },
			],
		}),
	).toMatchObject({ ok: true });
	const [marker] = active().markers;
	const swap = () =>
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Swap",
			ops: [{ op: "swap_take", markerId: marker.id, takeIndex: 0 }],
		});
	expect(swap()).toMatchObject({ ok: true });
	expect(flags()).toEqual([[second, false]]);
	expect(active().markers[0]?.data?.badTakePlacements).toEqual([
		[{ trackId: expect.any(String), volume: 0, noiseReduction: true }],
	]);
	expect(swap()).toMatchObject({ ok: true });
	expect(flags()).toEqual([[first, true]]);
});

test("a take with extracted audio and keyframed volume keeps its noise reduction when swapped out and back", () => {
	const animations = {
		volume: {
			keys: [
				{
					id: "key",
					time: ZERO_MEDIA_TIME,
					value: -6,
					segmentToNext: "linear",
					tangentMode: "auto",
				},
			],
		},
	} satisfies ClipAnimations;
	const { tracks } = active();
	editor.timeline.updateTracks({
		...tracks,
		main: {
			...tracks.main,
			clips: [
				{
					...videoClip({ id: "best", start: 0, duration: 2, trimStart: 4 }),
					mediaId: first,
					params: { noiseReduction: true },
					animations,
				},
			],
		},
		audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
	});
	editor.command.execute({
		command: new ToggleSourceAudioSeparationCommand({
			trackId: tracks.main.id,
			clipId: "best",
		}),
	});
	const extracted = () =>
		active().tracks.audio.flatMap(({ clips }) =>
			clips.filter((clip) => "mediaId" in clip && clip.mediaId === first),
		);
	// Extracting audio keeps it denoised.
	expect(extracted()).toMatchObject([{ params: { noiseReduction: true } }]);
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Marker",
			ops: [
				{
					op: "add_marker",
					at: { seconds: 1 },
					data: {
						kind: "removal",
						sectionName: "Intro",
						bestTake: { projectItemId: first, sourceIn: 4, sourceOut: 6 },
						badTakes: [{ projectItemId: second, sourceIn: 0, sourceOut: 3 }],
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	const [marker] = active().markers;
	const swap = () =>
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Swap",
			ops: [{ op: "swap_take", markerId: marker.id, takeIndex: 0 }],
		});
	expect(swap()).toMatchObject({ ok: true });
	expect(extracted()).toEqual([]);
	// Keyframed volume has no single gain to save, but noise reduction does.
	expect(active().markers[0]?.data?.badTakePlacements).toEqual([
		[
			{
				trackId: expect.any(String),
				audioTrackId: expect.any(String),
				noiseReduction: true,
			},
		],
	]);
	expect(swap()).toMatchObject({ ok: true });
	expect(flags()).toEqual([[first, true]]);
	expect(extracted()).toMatchObject([{ params: { noiseReduction: true } }]);
});

const keyframedVolume = {
	volume: {
		keys: [
			{
				id: "key",
				time: ZERO_MEDIA_TIME,
				value: -6,
				segmentToNext: "linear",
				tangentMode: "auto",
			},
		],
	},
} satisfies ClipAnimations;

const swapBackCases: Array<{
	name: string;
	swapped: { noiseReduction: boolean; volume: number };
	remaining: Pick<VideoClip, "params"> | Pick<VideoClip, "animations">;
	saved: { volume: number; noiseReduction: boolean };
}> = [
	{
		name: "denoised at +7 dB beside a plain -5 dB clip",
		swapped: { noiseReduction: true, volume: 7 },
		remaining: { params: { volume: -5 } },
		saved: { volume: 7, noiseReduction: true },
	},
	{
		name: "denoised at +7 dB beside a plain clip with keyframed volume",
		swapped: { noiseReduction: true, volume: 7 },
		remaining: { animations: keyframedVolume },
		saved: { volume: 7, noiseReduction: true },
	},
	{
		name: "plain at 0 dB beside a denoised +7 dB clip",
		swapped: { noiseReduction: false, volume: 0 },
		remaining: { params: { noiseReduction: true, volume: 7 } },
		saved: { volume: 0, noiseReduction: false },
	},
];

for (const { name, swapped, remaining, saved } of swapBackCases)
	test(`a take swapped out and back plays as it did, ${name} of its recording`, () => {
		const { tracks } = active();
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					{
						...videoClip({ id: "best", start: 0, duration: 2, trimStart: 4 }),
						mediaId: first,
						params: swapped,
					},
					{
						...videoClip({ id: "later", start: 5, duration: 2, trimStart: 8 }),
						mediaId: first,
						...remaining,
					},
				],
			},
			audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
		});
		expect(
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Marker",
				ops: [
					{
						op: "add_marker",
						at: { seconds: 1 },
						data: {
							kind: "removal",
							sectionName: "Intro",
							bestTake: { projectItemId: first, sourceIn: 4, sourceOut: 6 },
							badTakes: [{ projectItemId: second, sourceIn: 0, sourceOut: 3 }],
						},
					},
				],
			}),
		).toMatchObject({ ok: true });
		const [marker] = active().markers;
		const swap = () =>
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Swap",
				ops: [{ op: "swap_take", markerId: marker.id, takeIndex: 0 }],
			});
		expect(swap()).toMatchObject({ ok: true });
		expect(active().markers[0]?.data?.badTakePlacements).toEqual([
			[{ trackId: expect.any(String), ...saved }],
		]);
		expect(swap()).toMatchObject({ ok: true });
		const [back] = active().tracks.main.clips;
		expect([
			"mediaId" in back ? back.mediaId : null,
			back.params.noiseReduction ?? false,
			back.params.volume,
		]).toEqual([first, swapped.noiseReduction, swapped.volume]);
	});

for (const extract of [false, true])
	test(`a take split into a denoised +7 dB clip and a plain -5 dB clip swaps and restores as it played${extract ? ", with extracted audio" : ""}`, () => {
		const { tracks } = active();
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					{
						...videoClip({ id: "loud", start: 0, duration: 1, trimStart: 4 }),
						mediaId: first,
						params: { noiseReduction: true, volume: 7 },
					},
					{
						...videoClip({ id: "plain", start: 1, duration: 1, trimStart: 5 }),
						mediaId: first,
						params: { volume: -5 },
					},
				],
			},
			audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
		});
		if (extract)
			for (const clipId of ["loud", "plain"])
				editor.command.execute({
					command: new ToggleSourceAudioSeparationCommand({
						trackId: tracks.main.id,
						clipId,
					}),
				});
		expect(
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Marker",
				ops: [
					{
						op: "add_marker",
						at: { seconds: 1 },
						data: {
							kind: "removal",
							sectionName: "Intro",
							bestTake: { projectItemId: first, sourceIn: 4, sourceOut: 6 },
							badTakes: [{ projectItemId: second, sourceIn: 0, sourceOut: 3 }],
						},
					},
				],
			}),
		).toMatchObject({ ok: true });
		const [marker] = active().markers;
		const edit = (op: "swap_take" | "restore_takes") =>
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Take",
				ops: [{ op, markerId: marker.id, takeIndex: 0 }],
			});
		const heard = () =>
			(extract
				? active().tracks.audio.flatMap(({ clips }) => clips)
				: active().tracks.main.clips
			)
				.filter((clip) => "mediaId" in clip && clip.mediaId === first)
				.sort((a, b) => a.startTime - b.startTime)
				.map((clip) => [
					mediaTimeToSeconds({ time: clip.trimStart }),
					mediaTimeToSeconds({ time: clip.duration }),
					clip.params.noiseReduction ?? false,
					clip.params.volume,
				]);
		const asPlayed = [
			[4, 1, true, 7],
			[5, 1, false, -5],
		];
		expect(heard()).toEqual(asPlayed);

		expect(edit("swap_take")).toMatchObject({ ok: true });
		expect(heard()).toEqual([]);
		expect(active().markers[0]?.data?.badTakePlacements).toEqual([
			[
				{
					trackId: expect.any(String),
					...(extract && { audioTrackId: expect.any(String) }),
					volume: 7,
					noiseReduction: true,
					audioSegments: [
						{
							from: 4,
							volume: 7,
							noiseReduction: true,
							...(extract && { audioTrackId: expect.any(String) }),
						},
						{
							from: 5,
							volume: -5,
							noiseReduction: false,
							...(extract && { audioTrackId: expect.any(String) }),
						},
					],
				},
			],
		]);

		expect(edit("swap_take")).toMatchObject({ ok: true });
		expect(heard()).toEqual(asPlayed);
		editor.command.undo();

		expect(edit("restore_takes")).toMatchObject({ ok: true });
		expect(heard()).toEqual(asPlayed);
	});

test("takes saved before per-stretch audio restore with their saved gain or track alone", () => {
	const { tracks } = active();
	editor.timeline.updateTracks({
		...tracks,
		main: {
			...tracks.main,
			clips: [
				{
					...videoClip({ id: "kept", start: 0, duration: 2, trimStart: 8 }),
					mediaId: first,
					params: { noiseReduction: true, volume: 4 },
				},
			],
		},
		audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
	});
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Marker",
			ops: [
				{
					op: "add_marker",
					at: { seconds: 2 },
					data: {
						kind: "removal",
						sectionName: "Intro",
						bestTake: { projectItemId: first, sourceIn: 8, sourceOut: 10 },
						badTakes: [
							{ projectItemId: first, sourceIn: 0, sourceOut: 2 },
							{ projectItemId: first, sourceIn: 2, sourceOut: 4 },
						],
						badTakePlacements: [
							[{ trackId: tracks.main.id, volume: -3 }],
							[{ trackId: tracks.main.id }],
						],
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	const [marker] = active().markers;
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Restore",
			ops: [{ op: "restore_takes", markerId: marker.id }],
		}),
	).toMatchObject({ ok: true });
	expect(
		active().tracks.main.clips.map((clip) => [
			mediaTimeToSeconds({ time: clip.trimStart }),
			clip.params.noiseReduction ?? false,
			clip.params.volume,
		]),
	).toEqual([
		[8, true, 4],
		// A saved gain alone played without noise reduction.
		[0, false, -3],
		// A saved track alone plays as the recording does elsewhere.
		[2, true, 4],
	]);
});

for (const firstExtracted of [false, true])
	test(`a take split into ${firstExtracted ? "extracted audio" : "its own audio"} and audio extracted to a muted track swaps and restores each stretch on its route`, () => {
		const { tracks } = active();
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					{
						...videoClip({ id: "loud", start: 0, duration: 1, trimStart: 4 }),
						mediaId: first,
						params: { noiseReduction: true, volume: 7 },
					},
					{
						...videoClip({ id: "plain", start: 1, duration: 1, trimStart: 5 }),
						mediaId: first,
						params: { volume: -5 },
					},
				],
			},
			audio: tracks.audio.map((track) => ({ ...track, clips: [] })),
		});
		for (const clipId of firstExtracted ? ["loud", "plain"] : ["plain"])
			editor.command.execute({
				command: new ToggleSourceAudioSeparationCommand({
					trackId: tracks.main.id,
					clipId,
				}),
			});
		// The second stretch's extracted audio sits alone on a muted track.
		const separated = active().tracks;
		const plainAudio = separated.audio
			.flatMap(({ clips }) => clips)
			.find((clip) => clip.trimStart === s(5));
		if (!plainAudio) throw new Error("The plain stretch's audio wasn't extracted.");
		editor.timeline.updateTracks({
			...separated,
			audio: [
				...separated.audio.map((track) => ({
					...track,
					clips: track.clips.filter(({ id }) => id !== plainAudio.id),
				})),
				{
					...buildEmptyTrack({ id: "muted", type: "audio" }),
					muted: true,
					clips: [plainAudio],
				},
			],
		});
		expect(
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Marker",
				ops: [
					{
						op: "add_marker",
						at: { seconds: 1 },
						data: {
							kind: "removal",
							sectionName: "Intro",
							bestTake: { projectItemId: first, sourceIn: 4, sourceOut: 6 },
							badTakes: [{ projectItemId: second, sourceIn: 0, sourceOut: 3 }],
						},
					},
				],
			}),
		).toMatchObject({ ok: true });
		const [marker] = active().markers;
		const edit = (op: "swap_take" | "restore_takes") =>
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Take",
				ops: [{ op, markerId: marker.id, takeIndex: 0 }],
			});
		const isFirst = (clip: TimelineClip) =>
			"mediaId" in clip && clip.mediaId === first;
		// Where each stretch of the recording plays its audio from.
		const routes = () => {
			const { main, audio } = active().tracks;
			return [
				...main.clips
					.filter(
						(clip) =>
							isFirst(clip) &&
							clip.type === "video" &&
							clip.isSourceAudioEnabled !== false,
					)
					.map((clip) => ({ clip, route: "own audio" })),
				...audio.flatMap((track) =>
					track.clips.filter(isFirst).map((clip) => ({
						clip,
						route: track.id === "muted" ? "muted track" : "audio track",
					})),
				),
			]
				.sort((a, b) => a.clip.trimStart - b.clip.trimStart)
				.map(({ clip, route }) => [
					mediaTimeToSeconds({ time: clip.trimStart }),
					route,
					clip.params.noiseReduction ?? false,
					clip.params.volume,
				]);
		};
		const asPlayed = [
			[4, firstExtracted ? "audio track" : "own audio", true, 7],
			[5, "muted track", false, -5],
		];
		expect(routes()).toEqual(asPlayed);

		expect(edit("swap_take")).toMatchObject({ ok: true });
		expect(routes()).toEqual([]);
		// The muted track stays while the take that played on it is stored,
		// even once the swapped-in take leaves it empty.
		expect(
			active().tracks.audio.find(({ id }) => id === "muted"),
		).toMatchObject({ muted: true });
		const data = active().markers[0]?.data;
		expect(data?.badTakePlacements?.[0]?.[0]?.audioSegments).toEqual([
			{
				from: 4,
				volume: 7,
				noiseReduction: true,
				...(firstExtracted && { audioTrackId: expect.any(String) }),
			},
			{ from: 5, volume: -5, noiseReduction: false, audioTrackId: "muted" },
		]);
		// What a swap saves loads back from disk.
		expect(removalMarkerDataSchema.safeParse(data).success).toBe(true);

		expect(edit("swap_take")).toMatchObject({ ok: true });
		expect(routes()).toEqual(asPlayed);
		editor.command.undo();

		expect(edit("restore_takes")).toMatchObject({ ok: true });
		expect(routes()).toEqual(asPlayed);
	});

test("add_marker refuses saved audio segments that don't rise strictly within the take", () => {
	const addMarker = (offsets: number[]) =>
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Marker",
			ops: [
				{
					op: "add_marker",
					at: { seconds: 1 },
					data: {
						kind: "removal",
						sectionName: "Intro",
						bestTake: { projectItemId: first, sourceIn: 0, sourceOut: 1 },
						badTakes: [{ projectItemId: first, sourceIn: 4, sourceOut: 6 }],
						badTakePlacements: [
							[
								{
									trackId: active().tracks.main.id,
									audioSegments: offsets.map((from, index) => ({
										from,
										noiseReduction: index % 2 === 0,
									})),
								},
							],
						],
					},
				},
			],
		});
	for (const offsets of [
		[4, 5.5, 5],
		[4, 5, 5],
		[3, 5],
		[4, 6],
	])
		expect(addMarker(offsets)).toMatchObject({
			ok: false,
			code: "INVALID_REQUEST",
		});
	expect(active().markers).toEqual([]);

	expect(addMarker([4, 5])).toMatchObject({ ok: true });
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Restore",
			ops: [{ op: "restore_takes", markerId: active().markers[0].id }],
		}),
	).toMatchObject({ ok: true });
	// Each stretch plays once.
	expect(
		active()
			.tracks.main.clips.filter(
				(clip) =>
					"mediaId" in clip &&
					clip.mediaId === first &&
					clip.trimStart >= s(4) &&
					clip.trimStart < s(6),
			)
			.map((clip) => [
				mediaTimeToSeconds({ time: clip.trimStart }),
				mediaTimeToSeconds({ time: clip.duration }),
				clip.params.noiseReduction ?? false,
			]),
	).toEqual([
		[4, 1, true],
		[5, 1, false],
	]);
});

test("a restored take stored in the browser isn't marked denoised, even when saved that way", () => {
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Marker",
			ops: [
				{
					op: "add_marker",
					at: { seconds: 1 },
					data: {
						kind: "removal",
						sectionName: "Intro",
						bestTake: { projectItemId: first, sourceIn: 0, sourceOut: 1 },
						badTakes: [{ projectItemId: "browser", sourceIn: 4, sourceOut: 6 }],
						badTakePlacements: [
							[
								{
									trackId: active().tracks.main.id,
									volume: 3,
									noiseReduction: true,
								},
							],
						],
					},
				},
			],
		}),
	).toMatchObject({ ok: true });
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Restore",
			ops: [{ op: "restore_takes", markerId: active().markers[0].id }],
		}),
	).toMatchObject({ ok: true });
	const restored = active().tracks.main.clips.find(
		(clip) =>
			"mediaId" in clip &&
			clip.mediaId === "browser" &&
			clip.trimStart === s(4),
	);
	expect(restored?.params).toMatchObject({ volume: 3 });
	expect(restored?.params.noiseReduction ?? false).toBe(false);
	expect(api.getDigest()).not.toContain("denoised");
});

for (const mutedOn of ["clip", "track"] as const)
	test(`restored takes don't inherit noise reduction or gain from ${mutedOn === "clip" ? "muted clips" : "clips on a muted track"}`, () => {
		const { tracks } = active();
		const denoised = { noiseReduction: true, ...(mutedOn === "clip" && { muted: true }) };
		const quiet = [
			{
				...videoClip({ id: "quiet-1", start: 1, duration: 1, trimStart: 2 }),
				mediaId: first,
				params: denoised,
			},
			{
				...videoClip({ id: "quiet-2", start: 2, duration: 1, trimStart: 3 }),
				mediaId: first,
				params: denoised,
			},
		];
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					{
						...videoClip({ id: "heard", start: 0, duration: 1, trimStart: 0 }),
						mediaId: first,
						params: { volume: -5 },
					},
					...(mutedOn === "clip" ? quiet : []),
				],
			},
			audio: [
				...tracks.audio.map((track) => ({ ...track, clips: [] })),
				...(mutedOn === "track"
					? [
							{
								...buildEmptyTrack({ id: "muted", type: "audio" }),
								muted: true,
								clips: quiet.map((clip) => ({
									...audioClip({ id: clip.id, start: 1, duration: 1 }),
									startTime: clip.startTime,
									trimStart: clip.trimStart,
									mediaId: first,
									params: denoised,
								})),
							},
						]
					: []),
			],
		});
		expect(
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Marker",
				ops: [
					{
						op: "add_marker",
						at: { seconds: 3 },
						data: {
							kind: "removal",
							sectionName: "Intro",
							bestTake: { projectItemId: first, sourceIn: 0, sourceOut: 1 },
							badTakes: [{ projectItemId: first, sourceIn: 8, sourceOut: 10 }],
						},
					},
				],
			}),
		).toMatchObject({ ok: true });
		expect(
			api.apply({
				sequenceId: active().id,
				expectedRevision: api.getRevision(),
				label: "Restore",
				ops: [{ op: "restore_takes", markerId: active().markers[0].id }],
			}),
		).toMatchObject({ ok: true });
		const restored = active().tracks.main.clips.find(
			(clip) => clip.trimStart === s(8),
		);
		expect([
			restored?.params.noiseReduction ?? false,
			restored?.params.volume,
		]).toEqual([false, -5]);
	});
