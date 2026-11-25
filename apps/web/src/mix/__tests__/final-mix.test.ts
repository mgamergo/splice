import { expect, spyOn, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor, s, videoClip } from "@/agent/__tests__/fixtures";
import { setCaptionSources } from "@/captions/project-captions";
import { createTabHandlers } from "@/bridge/handlers";
import type { ProjectItem } from "@/media/types";
import { buildDefaultSequence } from "@/timeline/sequences";
import {
	hasAnimatedVolume,
	resolveEffectiveAudioGain,
} from "@/timeline/audio-state";
import { mixFingerprint } from "../final-mix";
import {
	duckedPassages,
	envelopeAt,
	musicEnvelope,
	speechPassages,
	tracksWithMusicDucking,
	musicTimingFingerprint,
	isCurrentOverride,
} from "../music";

const tracks = {
	...buildDefaultSequence({ name: "Main", isMain: true }).tracks,
	main: {
		id: "v1",
		name: "V1",
		type: "video",
		muted: false,
		hidden: false,
		clips: [
			videoClip({ id: "narration", start: 0, duration: 8, trimStart: 2 }),
		],
	},
} satisfies ReturnType<typeof buildDefaultSequence>["tracks"];

function item({
	id,
	type,
	duration,
}: Pick<ProjectItem, "id" | "type" | "duration">): ProjectItem {
	return {
		id,
		type,
		name: id,
		duration,
		file: new File([], id),
	};
}

test("ducks trimmed narration and application sounds, holding through short pauses", () => {
	const { passages } = speechPassages({
		tracks,
		projectItems: [item({ id: "rec", type: "video", duration: 10 })],
		sources: [
			{
				projectItemId: "rec",
				words: [
					{ start: 0, end: 1, text: "discarded" },
					{ start: 3, end: 3.5, text: "play" },
					{ start: 4, end: 4.5, text: "this" },
				],
			},
		],
		music: undefined,
	});
	const ducked = duckedPassages({
		speech: passages,
		overrides: [{ start: 5, end: 6 }],
		holdPauseSeconds: 1,
	});
	expect(ducked).toEqual([
		{ start: 1, end: 2.5 },
		{ start: 5, end: 6 },
	]);

	const points = musicEnvelope({
		passages: ducked,
		settings: {
			levelDb: -10,
			duckDb: -14,
			fadeInSeconds: 0.5,
			fadeOutSeconds: 0.5,
		},
		length: 8,
	});
	const at = (time: number) => envelopeAt({ points, time });
	expect(at(0)).toBe(-60);
	expect(at(1.75)).toBe(-24);
	expect(at(3)).toBeGreaterThan(-24);
	expect(at(4)).toBeLessThan(-10);
	expect(at(5.5)).toBe(-24);
	expect(at(8)).toBe(-60);
});

test("fits and trims music in one undoable track edit with editable volume keys", async () => {
	const editor = setUpEditor({ tracks });
	editor.media.setProjectItems({
		projectItems: [
			item({ id: "rec", type: "video", duration: 10 }),
			item({ id: "bed", type: "audio", duration: 3 }),
		],
	});
	const api = new EditorApi(editor);
	const request = () => ({
		expectedRevision: api.getRevision(),
		projectItemId: "bed",
		levelDb: -10,
	});
	const added = await api.addMusic({ request: request() });
	expect(added).toMatchObject({ ok: true, clipCount: 3, lengthSeconds: 8 });
	const music = editor.sequences.getActiveSequence().tracks.audio[0];
	expect(
		music.clips.map(({ startTime, duration, trimEnd }) => [
			startTime,
			duration,
			trimEnd,
		]),
	).toEqual([
		[s(0), s(3), s(0)],
		[s(3), s(3), s(0)],
		[s(6), s(2), s(1)],
	]);
	expect(
		resolveEffectiveAudioGain({ clip: music.clips[0], localTime: 0 }),
	).toBeCloseTo(0.001);
	expect(music.clips.every((clip) => hasAnimatedVolume({ clip }))).toBe(true);
	editor.command.undo();
	expect(editor.sequences.getActiveSequence().tracks.audio).toEqual([]);
	expect(editor.sequences.getActiveSequence().mix).toBeUndefined();
	editor.command.redo();
	expect(editor.sequences.getActiveSequence().tracks.audio).toHaveLength(1);
});

test("a picture repair leaves narration unchanged and its sound can be added separately", () => {
	const editor = setUpEditor({ tracks });
	const projectItems = [
		item({ id: "rec", type: "video", duration: 10 }),
		item({ id: "replacement", type: "video", duration: 6 }),
	];
	editor.media.setProjectItems({ projectItems });
	const api = new EditorApi(editor);
	const request = () => ({
		sequenceId: editor.sequences.getActiveSequence().id,
		expectedRevision: api.getRevision(),
	});
	const result = api.apply({
		...request(),
		label: "Repair picture",
		ops: [
			{
				op: "picture_repair",
				projectItemId: "replacement",
				at: { seconds: 2 },
				duration: { seconds: 2 },
				sourceIn: 1,
			},
		],
	});
	expect(result.ok).toBe(true);
	const repaired = editor.sequences.getActiveSequence().tracks;
	expect(repaired.main).toEqual(tracks.main);
	const video = repaired.overlay[0].clips[0];
	expect(video).toMatchObject({
		pictureRepair: true,
		isSourceAudioEnabled: false,
		trimStart: s(1),
	});
	expect(mixFingerprint({ tracks: repaired, projectItems })).toBe(
		mixFingerprint({ tracks, projectItems }),
	);

	const sound = api.apply({
		...request(),
		label: "Bring in the click",
		ops: [
			{
				op: "repair_sound",
				clipId: video.id,
				start: { seconds: 2.2 },
				end: { seconds: 2.5 },
			},
		],
	});
	expect(sound.ok).toBe(true);
	const withSound = editor.sequences.getActiveSequence().tracks;
	expect(withSound.audio[0].clips[0]).toMatchObject({
		mediaId: "replacement",
		startTime: s(2.2),
		trimStart: s(1.2),
		duration: s(0.3),
	});
	expect(mixFingerprint({ tracks: withSound, projectItems })).not.toBe(
		mixFingerprint({ tracks, projectItems }),
	);
	editor.command.undo();
	expect(editor.sequences.getActiveSequence().tracks).toEqual(repaired);
});

test("a music write refuses a stale revision and checks whether the agent was stopped while reading transcripts", async () => {
	const editor = setUpEditor({ tracks });
	editor.media.setProjectItems({
		projectItems: [item({ id: "bed", type: "audio", duration: 8 })],
	});
	const api = new EditorApi(editor);
	const args = {
		expectedRevision: api.getRevision(),
		projectItemId: "bed",
		levelDb: -10,
	};

	const pending = api.addMusic({ request: args });
	editor.command.bumpRevision();
	expect(await pending).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });

	let blocked = false;
	const handlers = createTabHandlers({ editor, api, isBlocked: () => blocked });
	const agentEdit = handlers["editor.addMusic"]({
		...args,
		expectedRevision: api.getRevision(),
	});
	blocked = true;
	await expect(agentEdit).rejects.toThrow("The creator stopped the agent");
	expect(editor.sequences.getActiveSequence().mix).toBeUndefined();
});

test("recomputes ducking after a take swap, flags old overrides and preserves trimmed music and creator keys", async () => {
	const editor = setUpEditor({ tracks });
	const projectItems = [
		item({ id: "rec", type: "video", duration: 10 }),
		item({ id: "alternate", type: "video", duration: 10 }),
		item({ id: "bed", type: "audio", duration: 8 }),
	];
	editor.media.setProjectItems({ projectItems });
	const sources = [
		{ projectItemId: "rec", words: [{ start: 2, end: 3, text: "early" }] },
		{
			projectItemId: "alternate",
			words: [{ start: 6, end: 7, text: "later" }],
		},
	];
	setCaptionSources({ editor, sources });
	const api = new EditorApi(editor);
	const revision = () => ({ expectedRevision: api.getRevision() });
	expect(
		await api.addMusic({
			request: {
				...revision(),
				projectItemId: "bed",
				levelDb: -10,
				fadeInSeconds: 0,
				fadeOutSeconds: 0,
				overrides: [{ start: 6, end: 7 }],
			},
		}),
	).toMatchObject({ ok: true });
	const current = () => editor.sequences.getActiveSequence();
	const gainAt = (localTime: number) =>
		resolveEffectiveAudioGain({
			clip: tracksWithMusicDucking({
				sequence: current(),
				projectItems,
				projectSources: sources,
			}).audio[0].clips[0],
			localTime,
		});
	expect(gainAt(4.5)).toBeCloseTo(10 ** (-10 / 20));
	const saved = current();
	const music = saved.tracks.audio[0];
	const bed = music.clips[0];
	const manual: typeof bed = {
		...bed,
		duration: s(7.5),
		trimEnd: s(0.5),
		animations: {
			volume: {
				keys: [
					{
						id: "manual-level",
						time: s(2),
						value: -12,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	};
	editor.sequences.updateSequenceTracks({
		tracks: {
			...saved.tracks,
			main: {
				...saved.tracks.main,
				clips: saved.tracks.main.clips.map((clip) => ({
					...clip,
					mediaId: "alternate",
					duration: s(7.5),
				})),
			},
			audio: [{ ...music, clips: [manual] }],
		},
	});
	expect(gainAt(4.5)).toBeCloseTo(10 ** (-26 / 20));
	// The old override would still hold the music at -26 dB here.
	expect(gainAt(7.25)).toBeCloseTo(10 ** (-12 / 20));
	const settings = current().mix?.music;
	if (!settings) throw new Error("Expected music");
	expect(
		isCurrentOverride({
			override: settings.overrides[0],
			fingerprint: musicTimingFingerprint({
				tracks: current().tracks,
				music: settings,
			}),
		}),
	).toBe(false);
	expect(
		await api.updateMusic({
			request: {
				...revision(),
				overrides: [...settings.overrides, { start: 2, end: 2.5 }],
			},
		}),
	).toMatchObject({ ok: true });
	expect(current().tracks.audio[0].clips[0]).toBe(manual);
	expect(gainAt(2.25)).toBeCloseTo(10 ** (-26 / 20));

	expect(
		await api.updateMusic({ request: { ...revision(), refit: true } }),
	).toMatchObject({ ok: true });
	expect(gainAt(7.25)).toBeCloseTo(10 ** (-10 / 20));
});

test("music_add rejects a stale Footage path request before it probes media", async () => {
	const editor = setUpEditor({ tracks });
	const api = new EditorApi(editor);
	const stale = api.getRevision();
	editor.command.bumpRevision();
	const fetch = spyOn(globalThis, "fetch");
	try {
		expect(
			await api.addMusic({
				request: { path: "bed.wav", expectedRevision: stale },
			}),
		).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
		expect(fetch).not.toHaveBeenCalled();
		expect(editor.media.getProjectItems()).toEqual([]);
	} finally {
		fetch.mockRestore();
	}
});
