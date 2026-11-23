import { describe, expect, test } from "bun:test";
import {
	buildCaptionCues,
	CAPTION_TRACK_NAME,
	mapWordsToTimeline,
	rebuildCaptions,
	withCaptionTrack,
	withoutCaptionTrack,
} from "@/agent/captions";
import { buildEmptyTrack } from "@/timeline/placement";
import { EditorApi } from "@/agent/editor-api";
import {
	audioClip,
	s,
	setUpEditor,
	videoClip,
} from "@/agent/__tests__/fixtures";
import { buildDefaultSequence } from "@/timeline/sequences";
import { mediaTimeToSeconds } from "@/wasm";
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

describe("mapWordsToTimeline follows the audio", () => {
	test("uses extracted audio where it was moved, and hidden video that still plays its audio", () => {
		const tracks = tracksWith({});
		tracks.main = {
			...tracks.main,
			clips: [
				{
					...videoClip({ id: "separated", start: 0, duration: 4 }),
					isSourceAudioEnabled: false,
				},
				{
					...videoClip({ id: "hidden", start: 10, duration: 4, trimStart: 20 }),
					hidden: true,
				},
			],
		};
		tracks.audio = [
			{
				id: "a1",
				name: "A1",
				type: "audio",
				muted: false,
				clips: [
					{
						...audioClip({ id: "moved", start: 5, duration: 4 }),
						mediaId: "rec",
					},
				],
			} as SequenceTracks["audio"][number],
		];
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{
					projectItemId: "rec",
					words: [word(1, 1.5, "moved"), word(21, 21.5, "hidden")],
				},
			],
		});
		expect(rounded(words)).toEqual([
			[6, 6.5, "moved"],
			[11, 11.5, "hidden"],
		]);
	});
});

describe("mapWordsToTimeline edge cases", () => {
	test("skips muted tracks and keeps a short word at a clip's end", () => {
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
				muted: true,
				clips: [audioClip({ id: "silent", start: 0, duration: 5 })],
			} as SequenceTracks["audio"][number],
		];
		const words = mapWordsToTimeline({
			tracks,
			sources: [
				{ projectItemId: "rec", words: [word(4.97, 4.989, "ok")] },
				{ projectItemId: "music", words: [word(1, 1.5, "muted")] },
			],
		});
		expect(rounded(words)).toEqual([[4.97, 4.989, "ok"]]);
	});

	test("skips clips muted on their own", () => {
		const tracks = tracksWith({});
		const clip = videoClip({ id: "v", start: 0, duration: 5 });
		tracks.main = {
			...tracks.main,
			clips: [{ ...clip, params: { ...clip.params, muted: true } }],
		};
		expect(
			mapWordsToTimeline({
				tracks,
				sources: [{ projectItemId: "rec", words: [word(1, 1.5, "muted")] }],
			}),
		).toEqual([]);
	});
});

describe("withoutCaptionTrack", () => {
	test("removes only the text track named Captions", () => {
		const tracks = tracksWith({
			overlay: [
				{ ...buildEmptyTrack({ id: "c", type: "text", name: CAPTION_TRACK_NAME }) },
				{ ...buildEmptyTrack({ id: "v", type: "video", name: CAPTION_TRACK_NAME }) },
			],
		});
		expect(
			withoutCaptionTrack({ tracks }).overlay.map(({ id }) => id),
		).toEqual(["v"]);
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

	test("many words on one time merge so each caption stays up long enough to see", () => {
		const stacked = Array.from({ length: 8 }, (_, index) =>
			word(1, 1, `w${index}`),
		);
		const cues = buildCaptionCues({
			words: [...stacked, word(1.3, 1.6, "next")],
			style: { wordsPerCaption: 1 },
		});
		expect(cues.map(({ text }) => text)).toEqual([
			"w0 w1",
			"w2 w3 w4",
			"w5 w6 w7",
			"next",
		]);
		for (const cue of cues) expect(cue.duration).toBeGreaterThanOrEqual(0.1);
		expect(cues[2].startTime + cues[2].duration).toBeCloseTo(1.3);
		expect(cues.at(-1)).toMatchObject({ text: "next", startTime: 1.3 });
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
			["Welcome to the", 2, 0.225],
			["Editing", 2.225, 0.225],
			["Workshop.", 3.5, 0.8],
		]);
	});

	test("stacked words with too little time before the next caption join it", () => {
		const cues = buildCaptionCues({
			words: [word(1, 1, "w0"), word(1, 1, "w1"), word(1.05, 1.3, "next")],
			style: { wordsPerCaption: 1 },
		});
		expect(cues.map(({ text }) => text)).toEqual(["w0 w1 next"]);
		expect(cues[0]).toMatchObject({ startTime: 1 });
		expect(cues[0].duration).toBeCloseTo(0.6);
	});

	test("a word too short to read shares a caption with the next one", () => {
		const cues = buildCaptionCues({
			words: [
				word(0, 0.3, "This"),
				word(0.3, 0.34, "a"),
				word(0.34, 0.6, "test"),
			],
			style: { wordsPerCaption: 1 },
		});
		expect(cues.map(({ text }) => text)).toEqual(["This", "a test"]);
		expect(cues[1]).toMatchObject({ startTime: 0.3 });
		expect(cues[1].duration).toBeCloseTo(0.6);
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

	test("ends the last caption where the sequence's content ends", () => {
		const { editor, api } = setUp();
		api.addCaptions({
			expectedRevision: api.getRevision(),
			sources: [{ projectItemId: "rec", words: [word(4.6, 4.9, "end")] }],
		});
		const [clip] = captionTracks(editor)[0].clips;
		expect(clip.startTime + clip.duration).toBe(s(5));
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

describe("rebuildCaptions", () => {
	// Two words heard together at 1.0 s show one after another: "w1" at
	// 1.0–1.2 s and "w2" at 1.2–1.4 s. "z" follows at 5 s.
	function stackedSequence({
		correct = false,
		moveZ,
	}: { correct?: boolean; moveZ?: number } = {}) {
		const content = tracksWith({});
		content.main = {
			...content.main,
			clips: [videoClip({ id: "v", start: 0, duration: 10 })],
		};
		const captions = {
			sources: [
				{
					projectItemId: "rec",
					words: [word(1, 1.1, "w1"), word(1, 1.1, "w2"), word(5, 5.4, "z")],
				},
			],
			style: { wordsPerCaption: 1 },
		};
		const canvasSize = { width: 1080, height: 1920 };
		const built = withCaptionTrack({ tracks: content, captions, canvasSize }).tracks;
		// The creator may have corrected "w2", or dragged "z" a little later
		// than its word.
		const edit = (clip: TextClip): TextClip =>
			correct && clip.params.content === "w2"
				? { ...clip, params: { ...clip.params, content: "W2!" } }
				: moveZ !== undefined && clip.params.content === "z"
					? { ...clip, startTime: s(moveZ), params: { ...clip.params, content: "Z!" } }
					: clip;
		const sequence = {
			...buildDefaultSequence({ name: "S", isMain: true }),
			tracks: {
				...built,
				overlay: built.overlay.map((track) =>
					track.type === "text" ? { ...track, clips: track.clips.map(edit) } : track,
				),
			},
			captions,
		};
		const texts = (window: { start: number; end: number; delta: number }) => {
			const [track] = rebuildCaptions({
				sequence,
				tracks: content,
				canvasSize,
				window,
			}).overlay;
			if (track?.type !== "text") throw new Error("No Captions track");
			return track.clips.map((clip) => clip.params.content);
		};
		const timed = (window: { start: number; end: number; delta: number }) => {
			const [track] = rebuildCaptions({ sequence, tracks: content, canvasSize, window }).overlay;
			if (track?.type !== "text") throw new Error("No Captions track");
			return track.clips.map((clip) => [
				clip.params.content,
				Math.round(mediaTimeToSeconds({ time: clip.startTime }) * 1000) / 1000,
			]);
		};
		return { sequence, texts, timed };
	}

	test("rebuilds a run of stacked words whose tail the window removed", () => {
		const { sequence, texts } = stackedSequence();
		const [track] = sequence.tracks.overlay;
		expect(
			track?.type === "text" && track.clips.map((clip) => clip.params.content),
		).toEqual(["w1", "w2", "z"]);
		expect(texts({ start: s(1.2), end: s(1.4), delta: 0 })).toEqual(["w1", "w2", "z"]);
	});

	test("keeps a hand-corrected run of stacked words the window doesn't touch", () => {
		const { texts } = stackedSequence({ correct: true });
		expect(texts({ start: s(2), end: s(3), delta: 0 })).toEqual(["w1", "W2!", "z"]);
	});

	test("keeps a caption moved off its word's start outside the window", () => {
		const { timed } = stackedSequence({ moveZ: 5.1 });
		expect(timed({ start: s(2), end: s(3), delta: 0 })).toEqual([
			["w1", 1],
			["w2", 1.2],
			["Z!", 5.1],
		]);
	});

	test("keeps a moved caption right after a run the edit rebuilds", () => {
		const { timed } = stackedSequence({ moveZ: 1.4 });
		expect(timed({ start: s(1.2), end: s(1.4), delta: 0 })).toEqual([
			["w1", 1],
			["w2", 1.2],
			["Z!", 1.4],
		]);
	});

	test("rebuilds a run of stacked words whose head the window removed", () => {
		const { texts } = stackedSequence();
		expect(texts({ start: s(0.5), end: s(1.1), delta: 0 })).toEqual(["w1", "w2", "z"]);
	});

	test("captions only the words in the edited gap, so none repeat or go missing at its edges", () => {
		const content = tracksWith({});
		content.main = {
			...content.main,
			clips: [videoClip({ id: "v", start: 0, duration: 10 })],
		};
		const canvasSize = { width: 1080, height: 1920 };
		const intro = word(0, 0.4, "Intro");
		const following = word(3.1, 3.5, "Following.");
		// Before the edit only these two were heard: "Intro" 0–0.7 and
		// "Following." from 3.1, which the creator corrected by hand.
		const old = withCaptionTrack({
			tracks: content,
			captions: { sources: [{ projectItemId: "rec", words: [intro, following] }] },
			canvasSize,
		}).tracks;
		const [track] = old.overlay;
		if (track?.type !== "text") throw new Error("No Captions track");
		const oldTrack = {
			...track,
			clips: track.clips.map((clip) =>
				clip.params.content === "Following."
					? { ...clip, params: { ...clip.params, content: "Corrected." } }
					: clip,
			),
		};
		const sequence = {
			...buildDefaultSequence({ name: "S", isMain: true }),
			tracks: { ...old, overlay: [oldTrack] },
			captions: {
				sources: [
					{
						projectItemId: "rec",
						// "Back" would join "Intro", and "Replacement" would join
						// "Following.", if the gap's words were grouped with theirs.
						words: [
							intro,
							word(0.8, 1, "Back"),
							word(2.7, 3, "Replacement"),
							following,
						],
					},
				],
			},
		};
		const rebuilt = rebuildCaptions({
			sequence,
			tracks: content,
			canvasSize,
			window: { start: s(0.7), end: s(3.1), delta: 0 },
		});
		const [captions] = rebuilt.overlay;
		if (captions?.type !== "text") throw new Error("No Captions track");
		expect(captions.clips.map((clip) => clip.params.content)).toEqual([
			"Intro",
			"Back",
			"Replacement",
			"Corrected.",
		]);
	});
});
