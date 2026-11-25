import { afterEach, describe, expect, test } from "bun:test";
import type { Replacement } from "@splice/bridge/delivery";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { useCaptionsStore } from "@/captions/store";
import { useTranscriptStore } from "@/cut-transcript/store";
import type { EditorCore } from "@/core";
import { buildDefaultSequence } from "@/timeline/sequences";

const initialCaptionsState = useCaptionsStore.getState();

// eslint-disable-next-line opencut/prefer-object-params -- terse test data
const word = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});

const sources = [
	{
		projectItemId: "rec",
		words: [
			word(1, 1.3, "Open"),
			word(1.35, 1.6, "next"),
			word(1.65, 2, "js."),
			word(4, 4.3, "Pick"),
			word(4.35, 4.7, "a"),
			word(4.75, 5, "theme."),
			word(7, 7.3, "Then"),
			word(7.35, 7.7, "save."),
		],
	},
];

function horizontalEditor(
	clips = [videoClip({ id: "a", start: 0, duration: 10 })],
): { editor: EditorCore; api: EditorApi } {
	const { main } = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	const editor = setUpEditor({
		tracks: {
			main: { ...main, clips },
		},
	});
	const api = new EditorApi(editor);
	api.addCaptions({ expectedRevision: api.getRevision(), sources });
	useCaptionsStore.setState({ spellingsLoaded: true });
	return { editor, api };
}

afterEach(() => {
	useCaptionsStore.setState(initialCaptionsState, true);
	useTranscriptStore.getState().clear();
});

describe("Cut transcript through the editor API", () => {
	test("cut_transcript reads the sentences with their sequence times", async () => {
		const { editor, api } = horizontalEditor();
		const result = await api.cutTranscript({});
		if (!result.ok) throw new Error(result.message);
		expect(result.sequenceId).toBe(editor.sequences.getActiveSequence().id);
		const sentences = result.paragraphs.flatMap(({ sentences }) => sentences);
		expect(sentences.map(({ text }) => text)).toEqual([
			"Open next js.",
			"Pick a theme.",
			"Then save.",
		]);
		expect(sentences[1].start).toBe(4);
		expect(await api.cutTranscript({ sequenceId: "nope" })).toMatchObject({
			ok: false,
			code: "INVALID_OP",
		});
	});

	test("transcript_selection returns the creator's passage, and lapses when an edit removes it", async () => {
		const { editor, api } = horizontalEditor();
		expect(await api.transcriptSelection({})).toMatchObject({
			ok: true,
			selection: null,
		});

		const transcript = await api.cutTranscript({});
		if (!transcript.ok) throw new Error(transcript.message);
		const { paragraphs, sequenceId } = transcript;
		const [first, second] = paragraphs.flatMap(({ sentences }) => sentences);
		const store = useTranscriptStore.getState();
		store.select({ sequenceId, sentenceId: second.id });
		store.select({ sequenceId, sentenceId: first.id, extend: true });
		const selected = await api.transcriptSelection({});
		if (!selected.ok) throw new Error(selected.message);
		expect(selected.selection).toMatchObject({
			sequenceId,
			start: 1,
			text: "Open next js. Pick a theme.",
		});
		expect(selected.selection?.end).toBe(second.end);

		// Cutting "Pick a theme." away removes a selected sentence.
		const result = api.apply({
			expectedRevision: api.getRevision(),
			sequenceId: editor.sequences.getActiveSequence().id,
			label: "Cut a sentence",
			ops: [
				{
					op: "ripple_delete",
					ranges: [{ start: { seconds: 3.5 }, end: { seconds: 5.5 } }],
				},
			],
		});
		expect(result).toMatchObject({ ok: true });
		expect(await api.transcriptSelection({})).toMatchObject({
			ok: true,
			selection: null,
			hint: expect.stringContaining("select it again"),
		});
	});

	test("deleting a repeated passage does not select the surviving copy", async () => {
		const { api } = horizontalEditor([
			videoClip({ id: "first", start: 0, duration: 3 }),
			videoClip({ id: "repeat", start: 10, duration: 3 }),
		]);
		const before = await api.cutTranscript({});
		if (!before.ok) throw new Error(before.message);
		const [first, repeat] = before.paragraphs.flatMap(
			({ sentences }) => sentences,
		);
		expect(first.text).toBe(repeat.text);
		useTranscriptStore.getState().select({
			sequenceId: before.sequenceId,
			sentenceId: first.id,
		});
		expect(await api.transcriptSelection({})).toMatchObject({
			ok: true,
			selection: { start: 1 },
		});

		expect(
			api.apply({
				expectedRevision: api.getRevision(),
				sequenceId: before.sequenceId,
				label: "Cut the first copy",
				ops: [
					{
						op: "ripple_delete",
						ranges: [{ start: { seconds: 0 }, end: { seconds: 3 } }],
					},
				],
			}),
		).toMatchObject({ ok: true });

		const after = await api.cutTranscript({});
		if (!after.ok) throw new Error(after.message);
		expect(after.paragraphs.flatMap(({ sentences }) => sentences)).toEqual([
			{ ...repeat, start: 8, end: repeat.end - 3 },
		]);
		expect(await api.transcriptSelection({})).toMatchObject({
			ok: true,
			selection: null,
			hint: expect.stringContaining("select it again"),
		});
	});

	test("a cue correction reaches the transcript only at its clip placement", async () => {
		const { api } = horizontalEditor([
			videoClip({ id: "first", start: 0, duration: 3 }),
			videoClip({ id: "repeat", start: 10, duration: 3 }),
		]);
		const before = await api.cutTranscript({});
		if (!before.ok) throw new Error(before.message);
		const [first, repeat] = before.paragraphs.flatMap(
			({ sentences }) => sentences,
		);
		useTranscriptStore.getState().select({
			sequenceId: before.sequenceId,
			sentenceId: repeat.id,
		});

		const captions = await api.captionCues({});
		if (!captions?.ok) throw new Error(captions?.message ?? "Expected captions.");
		expect(
			await api.correctCaption({
				sequenceId: before.sequenceId,
				expectedRevision: captions.revision,
				cueId: captions.cues[1].id,
				text: "Open Next.js.",
				scope: "cue",
			}),
		).toMatchObject({ ok: true });

		const after = await api.cutTranscript({});
		if (!after.ok) throw new Error(after.message);
		expect(after.paragraphs.flatMap(({ sentences }) => sentences)).toEqual([
			first,
			{ ...repeat, text: "Open Next.js." },
		]);
		expect(await api.transcriptSelection({})).toMatchObject({
			ok: true,
			selection: { text: "Open Next.js.", sentences: [{ id: repeat.id }] },
		});
	});

	test("both transcript reads use the revision, times and selection after spellings load", async () => {
		const { api } = horizontalEditor([
			{
				...videoClip({ id: "lead-in", start: 0, duration: 5 }),
				mediaId: "silent",
			},
			videoClip({ id: "speech", start: 5, duration: 10 }),
		]);
		const before = await api.cutTranscript({});
		if (!before.ok) throw new Error(before.message);
		const { paragraphs, sequenceId } = before;
		const [first, second] = paragraphs.flatMap(({ sentences }) => sentences);
		const store = useTranscriptStore.getState();
		store.select({ sequenceId, sentenceId: first.id });

		const spellings = Promise.withResolvers<Replacement[]>();
		useCaptionsStore.setState({ loadSpellings: () => spellings.promise });
		const transcriptRead = api.cutTranscript({});
		const selectionRead = api.transcriptSelection({});

		expect(
			api.apply({
				expectedRevision: api.getRevision(),
				sequenceId,
				label: "Cut the lead-in",
				ops: [
					{
						op: "ripple_delete",
						ranges: [{ start: { seconds: 0 }, end: { seconds: 5 } }],
					},
				],
			}),
		).toMatchObject({ ok: true });
		store.select({ sequenceId, sentenceId: second.id });
		spellings.resolve([]);

		const transcript = await transcriptRead;
		const selection = await selectionRead;
		const revision = api.getRevision();
		expect(transcript).toMatchObject({
			ok: true,
			revision,
		});
		if (!transcript.ok) throw new Error(transcript.message);
		expect(transcript.paragraphs[0].sentences[0]).toMatchObject({
			id: first.id,
			start: 1,
		});
		expect(selection).toMatchObject({
			ok: true,
			revision,
			selection: { start: 4, sentences: [{ id: second.id }] },
		});
		expect(await api.cutTranscript({})).toEqual(transcript);
		expect(selection).toEqual(await api.transcriptSelection({}));
	});
});
