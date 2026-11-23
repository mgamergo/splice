import { describe, expect, test } from "bun:test";
import {
	buildCaptionCues,
	CAPTION_TRACK_NAME,
	mapWordsToTimeline,
} from "@/agent/captions";
import { EditorApi } from "@/agent/editor-api";
import { audioClip, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { buildDefaultSequence } from "@/timeline/sequences";
import type { SequenceTracks, TextClip } from "@/timeline";

// eslint-disable-next-line opencut/prefer-object-params -- terse test data
const word = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});

function tracksWith(overrides: Partial<SequenceTracks>): SequenceTracks {
	return {
		...buildDefaultSequence({ name: "S", isMain: true }).tracks,
		...overrides,
	};
}

const rounded = (words: Array<{ start: number; end: number; text: string }>) =>
	words.map(({ start, end, text }) => [
		Math.round(start * 1000) / 1000,
		Math.round(end * 1000) / 1000,
		text,
	]);

describe("mapWordsToTimeline", () => {
	test("keeps words whose midpoint a clip shows, clamped to the clip", () => {
		const tracks = tracksWith({});
		tracks.main = {
			...tracks.main,
			clips: [videoClip({ id: "a", start: 10, duration: 4, trimStart: 5 })],
		};
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{
					projectItemId: "rec",
					words: [
						word(4.5, 4.8, "cut"),
						word(4.9, 5.3, "edge"),
						word(5.2, 5.6, "inside"),
						word(8.9, 9.4, "after"),
					],
				},
			],
		});
		expect(rounded(words)).toEqual([
			[10, 10.3, "edge"],
			[10.2, 10.6, "inside"],
		]);
	});

	test("keeps words whisper.cpp gave no duration", () => {
		const tracks = tracksWith({});
		tracks.main = {
			...tracks.main,
			clips: [videoClip({ id: "a", start: 0, duration: 5, trimStart: 9 })],
		};
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{
					projectItemId: "rec",
					words: [
						word(9, 9, "Welcome"),
						word(9, 9, "to"),
						word(9, 9.15, "Editing"),
					],
				},
			],
		});
		expect(rounded(words)).toEqual([
			[0, 0.08, "Welcome"],
			[0, 0.08, "to"],
			[0, 0.15, "Editing"],
		]);
	});

	test("captions each kept piece of a split recording in timeline order", () => {
		const tracks = tracksWith({});
		tracks.main = {
			...tracks.main,
			clips: [
				videoClip({ id: "late", start: 2, duration: 1, trimStart: 8 }),
				videoClip({ id: "early", start: 0, duration: 2, trimStart: 0 }),
			],
		};
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{
					projectItemId: "rec",
					words: [
						word(0.5, 0.9, "one"),
						word(4, 4.5, "gone"),
						word(8.2, 8.6, "two"),
					],
				},
			],
		});
		expect(rounded(words)).toEqual([
			[0.5, 0.9, "one"],
			[2.2, 2.6, "two"],
		]);
	});

	test("shows a video's words once even with its audio on another track, and falls back to audio-only items", () => {
		const tracks = tracksWith({});
		tracks.main = {
			...tracks.main,
			clips: [videoClip({ id: "v", start: 0, duration: 5 })],
		};
		tracks.audio = [
			{
				id: "a1",
				name: "A1",
				type: "audio",
				muted: false,
				clips: [
					{
						...audioClip({ id: "extracted", start: 0, duration: 5 }),
						mediaId: "rec",
					},
					audioClip({ id: "voice", start: 5, duration: 5 }),
				],
			} as SequenceTracks["audio"][number],
		];
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{ projectItemId: "rec", words: [word(1, 1.5, "video")] },
				{ projectItemId: "music", words: [word(2, 2.5, "audio")] },
			],
		});
		expect(rounded(words)).toEqual([
			[1, 1.5, "video"],
			[7, 7.5, "audio"],
		]);
	});
});

describe("buildCaptionCues", () => {
	test("groups up to three words, breaks at punctuation and pauses, and holds until the next caption", () => {
		const cues = buildCaptionCues({
			words: [
				word(0, 0.2, "one"),
				word(0.2, 0.4, "two"),
				word(0.4, 0.6, "three"),
				word(0.6, 0.8, "four."),
				word(0.8, 1, "five"),
				word(2, 2.2, "six"),
			],
		});
		expect(
			cues.map(({ text, startTime, duration }) => [
				text,
				startTime,
				Math.round(duration * 1000) / 1000,
			]),
		).toEqual([
			["one two three", 0, 0.6],
			["four.", 0.6, 0.2],
			["five", 0.8, 0.5],
			["six", 2, 0.5],
		]);
	});

	test("staggers captions whose words share one time instead of dropping them", () => {
		const cues = buildCaptionCues({
			words: [
				word(2, 2.08, "Welcome"),
				word(2, 2.08, "to"),
				word(2, 2.08, "the"),
				word(2, 2.15, "Editing"),
				word(3.5, 4, "Workshop."),
			],
		});
		expect(
			cues.map(({ text, startTime, duration }) => [
				text,
				Math.round(startTime * 1000) / 1000,
				Math.round(duration * 1000) / 1000,
			]),
		).toEqual([
			["Welcome to the", 2, 0.2],
			["Editing", 2.2, 0.25],
			["Workshop.", 3.5, 0.8],
		]);
	});

	test("applies the style", () => {
		const [cue] = buildCaptionCues({
			words: [word(0, 0.5, "hello"), word(0.5, 1, "there")],
			style: {
				wordsPerCaption: 1,
				uppercase: true,
				color: "#ffee00",
				background: "none",
				position: "top",
			},
		});
		expect(cue.text).toBe("HELLO");
		expect(cue.duration).toBe(0.5);
		expect(cue.style).toMatchObject({
			color: "#ffee00",
			background: { enabled: false },
			placement: { verticalAlign: "top" },
		});
	});
});

describe("EditorApi captions", () => {
	const sources = [
		{
			projectItemId: "rec",
			words: [
				word(0.5, 0.9, "Hello"),
				word(1, 1.4, "world."),
				word(3, 3.5, "Bye"),
			],
		},
	];

	function setUp() {
		const editor = setUpEditor({
			tracks: {
				main: {
					...tracksWith({}).main,
					clips: [videoClip({ id: "v", start: 0, duration: 5 })],
				},
			},
		});
		return { editor, api: new EditorApi(editor) };
	}

	const captionTracks = (editor: ReturnType<typeof setUp>["editor"]) =>
		editor.sequences
			.getActiveSequence()
			.tracks.overlay.filter(({ name }) => name === CAPTION_TRACK_NAME);

	test("adds a Captions track on top as one undo step, and replaces it when called again", () => {
		const { editor, api } = setUp();
		const first = api.addCaptions({
			expectedRevision: api.getRevision(),
			sources,
		});
		expect(first).toMatchObject({
			ok: true,
			captionCount: 2,
			label: "Agent: captions",
		});
		const [track] = captionTracks(editor);
		expect(editor.sequences.getActiveSequence().tracks.overlay[0]).toBe(track);
		expect(
			track.clips.map((clip) => (clip as TextClip).params.content),
		).toEqual(["Hello world.", "Bye"]);
		expect(api.getDigest()).toContain('"Caption 1" 0.50–1.70 "Hello world."]');

		api.addCaptions({
			expectedRevision: api.getRevision(),
			sources,
			style: { wordsPerCaption: 1 },
		});
		expect(captionTracks(editor)).toHaveLength(1);
		expect(captionTracks(editor)[0].clips).toHaveLength(3);

		editor.command.undo();
		expect(captionTracks(editor)[0].clips).toHaveLength(2);
		editor.command.undo();
		expect(captionTracks(editor)).toHaveLength(0);
	});

	test("refuses when no transcript word falls inside the sequence", () => {
		const { editor, api } = setUp();
		const before = api.getRevision();
		const result = api.addCaptions({
			expectedRevision: before,
			sources: [{ projectItemId: "other", words: [word(0, 1, "x")] }],
		});
		expect(result).toMatchObject({ ok: false, code: "INVALID_OP" });
		expect(api.getRevision()).toBe(before);
		expect(captionTracks(editor)).toHaveLength(0);
	});
});
