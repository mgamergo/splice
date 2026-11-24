import { beforeEach, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import {
	applySourceGains,
	collectAudioSources,
	LoudnessError,
} from "@/agent/loudness";
import type { ClipAnimations } from "@/animation/types";
import type { EditorCore } from "@/core";
import { collectAudioClipSources, mixAudioChannels } from "@/media/audio";
import type { ProjectItem } from "@/media/types";
import type { TimelineClip, VideoClip } from "@/timeline";
import { resolveEffectiveAudioGain } from "@/timeline/audio-state";
import { TICKS_PER_SECOND } from "@/wasm";

const first = "recording-1";
const second = "recording-2";
const section = {
	name: "Filter",
	takes: [
		{
			label: "Across files",
			ranges: [
				{ projectItemId: first, sourceIn: 8, sourceOut: 12 },
				{ projectItemId: second, sourceIn: 0, sourceOut: 2 },
			],
		},
		{ projectItemId: second, sourceIn: 4, sourceOut: 8 },
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

let editor: EditorCore;
let api: EditorApi;

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	editor.media.setProjectItems({
		projectItems: [diskItem(first), diskItem(second)],
	});
	api = new EditorApi(editor);
	api.rawSequence({
		projectItemIds: [first, second],
		expectedRevision: api.getRevision(),
	});
});

const active = () => editor.sequences.getActiveSequence();
const volumes = () =>
	active().tracks.main.clips.map((clip) => [
		clip.mediaId,
		"volume" in clip.params ? clip.params.volume : undefined,
	]);

test("collects each recording's audible source ranges, one per clip in playing order, with its Footage path", () => {
	const clip = ({
		id,
		start,
		duration,
		trimStart,
	}: {
		id: string;
		start: number;
		duration: number;
		trimStart: number;
	}): VideoClip => ({
		...videoClip({ id, start, duration, trimStart }),
		mediaId: first,
	});
	const muted: VideoClip = {
		...clip({ id: "muted", start: 6, duration: 1, trimStart: 20 }),
		params: { muted: true },
	};
	const browserItem: ProjectItem = {
		...diskItem("browser"),
		file: new File([], "browser.mov"),
	};
	const missingItem: ProjectItem = { ...diskItem("gone"), missing: true };
	const tracks = {
		...active().tracks,
		main: {
			...active().tracks.main,
			clips: [
				clip({ id: "a", start: 0, duration: 2, trimStart: 4 }),
				clip({ id: "b", start: 2, duration: 3, trimStart: 0 }),
				clip({ id: "c", start: 5, duration: 1, trimStart: 6 }),
				muted,
				{
					...clip({ id: "d", start: 7, duration: 1, trimStart: 0 }),
					mediaId: "browser",
				},
				// Plays the same audio as "a" again, so it counts again.
				clip({ id: "e", start: 8, duration: 2, trimStart: 4 }),
				{
					...clip({ id: "f", start: 10, duration: 1, trimStart: 0 }),
					mediaId: "gone",
				},
			] satisfies TimelineClip[],
		},
	};
	expect(
		collectAudioSources({
			tracks,
			projectItems: [diskItem(first), browserItem, missingItem],
		}),
	).toEqual([
		{
			projectItemId: first,
			path: `Day 1/${first}.mov`,
			noiseReduction: false,
			missing: false,
			clipIds: ["a", "b", "c", "e"],
			// In the order the clips play.
			ranges: [
				{ start: 4, end: 6 },
				{ start: 0, end: 3 },
				{ start: 6, end: 7 },
				{ start: 4, end: 6 },
			],
		},
		{
			projectItemId: "browser",
			path: null,
			noiseReduction: false,
			missing: false,
			clipIds: ["d"],
			ranges: [{ start: 0, end: 1 }],
		},
		{
			projectItemId: "gone",
			path: "Day 1/gone.mov",
			noiseReduction: false,
			missing: true,
			clipIds: ["f"],
			ranges: [{ start: 0, end: 1 }],
		},
	]);
});

test("a planned rough cut reports what it keeps without changing anything", () => {
	const raw = active();
	const revision = api.getRevision();
	expect(
		api.roughCut({
			sections: [section],
			expectedRevision: revision,
			plan: true,
		}),
	).toEqual({
		ok: true,
		revision,
		audioSources: [
			{
				projectItemId: first,
				path: `Day 1/${first}.mov`,
				noiseReduction: false,
				missing: false,
				clipIds: [expect.any(String)],
				ranges: [{ start: 0, end: 8 }],
			},
			{
				projectItemId: second,
				path: `Day 1/${second}.mov`,
				noiseReduction: false,
				missing: false,
				clipIds: [expect.any(String)],
				ranges: [{ start: 2, end: 12 }],
			},
		],
	});
	expect(api.getRevision()).toBe(revision);
	expect(active()).toBe(raw);
	expect(editor.sequences.getSequences()).toHaveLength(2);
});

test("the cut and its gains are one undo step", () => {
	const raw = active();
	const revision = api.getRevision();
	const result = api.roughCut({
		sections: [section],
		expectedRevision: revision,
		sourceGains: [
			{ projectItemId: first, gainDb: 13.5 },
			{ projectItemId: second, gainDb: 1.25 },
		],
	});
	expect(result).toMatchObject({ ok: true, revision: revision + 1 });
	expect(active().name).toBe("Rough Cut");
	expect(volumes()).toEqual([
		[first, 13.5],
		[second, 1.25],
	]);
	expect(api.getDigest()).toContain("gain +13.5 dB");
	editor.command.undo();
	expect(active()).toBe(raw);
	expect(editor.sequences.getSequences().map(({ name }) => name)).not.toContain(
		"Rough Cut",
	);
	expect(volumes()).toEqual([
		[first, 0],
		[second, 0],
	]);
	editor.command.redo();
	expect(volumes()).toEqual([
		[first, 13.5],
		[second, 1.25],
	]);
});

test("a plan or cut against a stale revision is refused", () => {
	const stale = api.getRevision() - 1;
	for (const plan of [true, false])
		expect(
			api.roughCut({ sections: [section], expectedRevision: stale, plan }),
		).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
});

test("set_gain sets clip volume as one undo step and refuses keyframed volume", () => {
	const clipIds = active().tracks.main.clips.map(({ id }) => id);
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Normalize",
			ops: [
				{ op: "set_gain", clipIds: [clipIds[0]], gainDb: -3 },
				{ op: "set_gain", clipIds: [clipIds[1]], gainDb: 6 },
			],
		}),
	).toEqual({
		ok: true,
		revision: expect.any(Number),
		label: "Normalize",
		summary: ["set 1 clip(s) to -3.0 dB", "set 1 clip(s) to +6.0 dB"],
	});
	expect(volumes()).toEqual([
		[first, -3],
		[second, 6],
	]);
	editor.command.undo();
	expect(volumes()).toEqual([
		[first, 0],
		[second, 0],
	]);

	// A gain would only shift keyframed volume's base value, so it is refused.
	const animations = { volume: { keys: [{}] } } as unknown as ClipAnimations;
	const keyframed = {
		...active().tracks,
		main: {
			...active().tracks.main,
			clips: active().tracks.main.clips.map((clip) => ({
				...clip,
				animations,
			})),
		},
	};
	expect(() =>
		applySourceGains({
			tracks: keyframed,
			projectItems: editor.media.getProjectItems(),
			gains: [{ projectItemId: first, gainDb: 3 }],
		}),
	).toThrow(LoudnessError);
	editor.sequences.updateSequenceTracks({ tracks: keyframed });
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Normalize",
			ops: [{ op: "set_gain", clipIds: [clipIds[0]], gainDb: 3 }],
		}),
	).toMatchObject({ ok: false, code: "INVALID_OP" });
});

test("playback and export apply a clip gain as 10^(dB/20)", async () => {
	api.roughCut({
		sections: [section],
		expectedRevision: api.getRevision(),
		sourceGains: [
			{ projectItemId: first, gainDb: 6 },
			{ projectItemId: second, gainDb: -12 },
		],
	});
	const { tracks } = active();
	const projectItems = editor.media.getProjectItems();

	// Playback gives each clip's gain node this value.
	const playback = await collectAudioClipSources({ tracks, projectItems });
	expect(playback.map(({ volume }) => volume)).toEqual([
		expect.closeTo(10 ** (6 / 20), 9),
		expect.closeTo(10 ** (-12 / 20), 9),
	]);

	// Export mixes each clip's samples at the same gain.
	const sampleRate = 100;
	const channel = ({ length, value }: { length: number; value: number }) =>
		new Float32Array(length).fill(value);
	const buffer = (channels: Float32Array[]) =>
		({
			numberOfChannels: channels.length,
			sampleRate,
			length: channels[0].length,
			getChannelData: (index: number) => channels[index],
		}) as unknown as AudioBuffer;
	const output = buffer([
		channel({ length: 1800, value: 0 }),
		channel({ length: 1800, value: 0 }),
	]);
	for (const clip of tracks.main.clips) {
		if (clip.type !== "video") continue;
		const source = buffer([channel({ length: 1200, value: 0.25 })]);
		mixAudioChannels({
			clip: {
				timelineClip: clip,
				buffer: source,
				startTime: clip.startTime / TICKS_PER_SECOND,
				duration: clip.duration / TICKS_PER_SECOND,
				trimStart: clip.trimStart / TICKS_PER_SECOND,
				trimEnd: 0,
				volume: resolveEffectiveAudioGain({ clip, localTime: 0 }),
				muted: false,
			},
			buffer: source,
			trimStart: clip.trimStart / TICKS_PER_SECOND,
			outputBuffer: output,
			outputLength: output.length,
			sampleRate,
		});
	}
	for (const index of [0, 1]) {
		const data = output.getChannelData(index);
		expect(data[100]).toBeCloseTo(0.25 * 10 ** (6 / 20), 5);
		expect(data[1000]).toBeCloseTo(0.25 * 10 ** (-12 / 20), 5);
	}
});
