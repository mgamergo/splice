import { describe, expect, test } from "bun:test";
import type { ProjectCaptions } from "@splice/bridge/delivery";
import { s, videoClip } from "@/agent/__tests__/fixtures";
import { buildCaptionCues } from "@/captions/cues";
import {
	buildCutTranscript,
	selectedSentences,
	sentenceAt,
} from "@/cut-transcript/transcript";
import type { Marker, SequenceTracks, VideoClip } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

// eslint-disable-next-line opencut/prefer-object-params -- terse test data
const word = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});

/** Words spoken one after another from `start`, each 0.3 s with 0.05 s gaps. */
// eslint-disable-next-line opencut/prefer-object-params -- terse test data
function speak(start: number, text: string) {
	return text.split(" ").map((part, index) =>
		word(start + index * 0.35, start + index * 0.35 + 0.3, part),
	);
}

function tracksWith(clips: VideoClip[]): SequenceTracks {
	const tracks = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	return { ...tracks, main: { ...tracks.main, clips } };
}

function clipOf({
	id,
	item = "rec",
	start,
	duration,
	trimStart = 0,
	markerIds,
}: {
	id: string;
	item?: string;
	start: number;
	duration: number;
	trimStart?: number;
	markerIds?: string[];
}): VideoClip {
	return {
		...videoClip({ id, start, duration, trimStart }),
		mediaId: item,
		...(markerIds && { bestTakeMarkerIds: markerIds }),
	};
}

function removalMarker({
	id,
	time,
	sectionName,
}: {
	id: string;
	time: number;
	sectionName: string;
}): Marker {
	const take = { projectItemId: "rec", sourceIn: 0, sourceOut: 1 };
	return {
		id,
		time: s(time),
		data: { kind: "removal", sectionName, bestTake: take, badTakes: [take] },
	};
}

function transcriptOf({
	tracks,
	sources,
	markers = [],
	captions = {},
}: {
	tracks: SequenceTracks;
	sources: ProjectCaptions["sources"];
	markers?: Marker[];
	captions?: Partial<ProjectCaptions>;
}) {
	const cues = buildCaptionCues({
		tracks,
		captions: { sources, cueEdits: [], replacements: [], ...captions },
		sequenceEnd: 600,
	});
	return buildCutTranscript({ cues, tracks, markers });
}

const texts = (sentences: Array<{ text: string }>) =>
	sentences.map(({ text }) => text);

describe("buildCutTranscript", () => {
	test("reads the cues as sentences, joining a sentence the cues split", () => {
		const long =
			"This sentence runs on for long enough that the captions have to split it into two cues for the viewer.";
		const words = [...speak(1, "Open the settings."), ...speak(2.1, long)];
		const { sentences, paragraphs } = transcriptOf({
			tracks: tracksWith([clipOf({ id: "a", start: 0, duration: 60 })]),
			sources: [{ projectItemId: "rec", words }],
		});
		expect(texts(sentences)).toEqual(["Open the settings.", long]);
		expect(sentences[0]).toMatchObject({ start: 1 });
		expect(sentences[1].cueIds.length).toBeGreaterThan(1);
		expect(sentences[1].start).toBeCloseTo(2.1, 5);
		expect(paragraphs).toHaveLength(1);
	});

	test("breaks sentences and paragraphs between cues from different recordings", () => {
		const tracks = tracksWith([
			clipOf({ id: "a", item: "one", start: 0, duration: 2 }),
			clipOf({ id: "b", item: "two", start: 2, duration: 2 }),
		]);
		const { sentences, paragraphs } = transcriptOf({
			tracks,
			sources: [
				{ projectItemId: "one", words: speak(0.2, "so we open it") },
				// A short silence ends the cue, though not the sentence by itself.
				{ projectItemId: "two", words: speak(0.7, "and then save") },
			],
		});
		expect(texts(sentences)).toEqual(["so we open it", "and then save"]);
		expect(paragraphs.map(({ sentences }) => texts(sentences))).toEqual([
			["so we open it"],
			["and then save"],
		]);
	});

	test("groups sentences by the section whose best take they are heard in", () => {
		const tracks = tracksWith([
			clipOf({ id: "a", start: 0, duration: 4, markerIds: ["m1"] }),
			clipOf({ id: "b", start: 4, duration: 4, trimStart: 10, markerIds: ["m2"] }),
		]);
		const { paragraphs } = transcriptOf({
			tracks,
			sources: [
				{
					projectItemId: "rec",
					words: [
						...speak(0.2, "Hi there."),
						...speak(1.2, "Welcome in."),
						...speak(10.2, "First, install it."),
					],
				},
			],
			markers: [
				removalMarker({ id: "m1", time: 0, sectionName: "Intro" }),
				removalMarker({ id: "m2", time: 4, sectionName: "Install" }),
			],
		});
		expect(
			paragraphs.map(({ section, sentences }) => ({
				section: section?.name,
				text: texts(sentences),
			})),
		).toEqual([
			{ section: "Intro", text: ["Hi there.", "Welcome in."] },
			{ section: "Install", text: ["First, install it."] },
		]);
		expect(paragraphs[1].section?.markerId).toBe("m2");
	});

	test("a take swap changes only its passage", () => {
		const sources = [
			{
				projectItemId: "rec",
				words: [
					...speak(0.2, "Start here."),
					...speak(10.2, "Take one says this."),
					...speak(20.2, "Take two says that."),
					...speak(30.2, "The end."),
				],
			},
		];
		const before = transcriptOf({
			tracks: tracksWith([
				clipOf({ id: "a", start: 0, duration: 2 }),
				clipOf({ id: "b", start: 2, duration: 2, trimStart: 10 }),
				clipOf({ id: "c", start: 4, duration: 2, trimStart: 30 }),
			]),
			sources,
		});
		const after = transcriptOf({
			tracks: tracksWith([
				clipOf({ id: "a", start: 0, duration: 2 }),
				clipOf({ id: "b", start: 2, duration: 2, trimStart: 20 }),
				clipOf({ id: "c", start: 4, duration: 2, trimStart: 30 }),
			]),
			sources,
		});
		expect(texts(before.sentences)).toEqual([
			"Start here.",
			"Take one says this.",
			"The end.",
		]);
		expect(texts(after.sentences)).toEqual([
			"Start here.",
			"Take two says that.",
			"The end.",
		]);
		// The sentences either side keep their ids, so a selection there survives.
		expect(after.sentences[0].id).toBe(before.sentences[0].id);
		expect(after.sentences[2].id).toBe(before.sentences[2].id);
		expect(after.sentences[1].id).not.toBe(before.sentences[1].id);
	});

	test("reads corrected words, and a hidden caption's words are still heard", () => {
		const words = [...speak(1, "Open next js."), ...speak(3, "Um, okay.")];
		const tracks = tracksWith([clipOf({ id: "a", start: 0, duration: 10 })]);
		const { sentences } = transcriptOf({
			tracks,
			sources: [{ projectItemId: "rec", words }],
			captions: {
				replacements: [{ from: "next js", to: "Next.js" }],
				cueEdits: [
					{
						words: [
							{ projectItemId: "rec", index: 3 },
							{ projectItemId: "rec", index: 4 },
						],
						text: "",
					},
				],
			},
		});
		expect(texts(sentences)).toEqual(["Open Next.js.", "Um, okay."]);
	});
});

describe("selection and playhead", () => {
	const { sentences } = transcriptOf({
		tracks: tracksWith([clipOf({ id: "a", start: 0, duration: 20 })]),
		sources: [
			{
				projectItemId: "rec",
				words: [
					...speak(1, "One."),
					...speak(3, "Two."),
					...speak(5, "Three."),
					...speak(7, "Four."),
				],
			},
		],
	});

	test("selects the run between two sentences in either order", () => {
		// eslint-disable-next-line opencut/prefer-object-params -- terse test data
		const range = (anchor: number, focus: number) =>
			texts(
				selectedSentences({
					sentences,
					anchorId: sentences[anchor].id,
					focusId: sentences[focus].id,
				}) ?? [],
			);
		expect(range(1, 2)).toEqual(["Two.", "Three."]);
		expect(range(3, 1)).toEqual(["Two.", "Three.", "Four."]);
		expect(range(0, 0)).toEqual(["One."]);
	});

	test("a selection lapses when an edit removes one of its sentences", () => {
		expect(
			selectedSentences({
				sentences: sentences.slice(1),
				anchorId: sentences[0].id,
				focusId: sentences[2].id,
			}),
		).toBeNull();
	});

	test("finds the sentence under the playhead", () => {
		expect(sentenceAt({ sentences, time: 3.1 })?.text).toBe("Two.");
		expect(sentenceAt({ sentences, time: 0.5 })).toBeUndefined();
	});
});
