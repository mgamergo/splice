import { afterEach, describe, expect, test } from "bun:test";
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

function horizontalEditor(): { editor: EditorCore; api: EditorApi } {
	const { main } = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	const editor = setUpEditor({
		tracks: {
			main: { ...main, clips: [videoClip({ id: "a", start: 0, duration: 10 })] },
		},
	});
	const api = new EditorApi(editor);
	api.addCaptions({ expectedRevision: api.getRevision(), sources });
	useCaptionsStore.setState({ spellingsLoaded: true });
	return { editor, api };
}

type Sentence = { id: string; start: number; end: number; text: string };
type Transcript = {
	ok: true;
	sequenceId: string;
	paragraphs: Array<{ sentences: Sentence[] }>;
};
type Selection = {
	ok: true;
	selection: {
		sequenceId: string;
		start: number;
		end: number;
		text: string;
		sentences: Sentence[];
	} | null;
	hint?: string;
};

afterEach(() => {
	useCaptionsStore.setState(initialCaptionsState, true);
	useTranscriptStore.getState().clear();
});

describe("Cut transcript through the editor API", () => {
	test("cut_transcript reads the sentences with their sequence times", async () => {
		const { editor, api } = horizontalEditor();
		const result = (await api.cutTranscript({})) as Transcript;
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
		expect((await api.transcriptSelection({})) as Selection).toMatchObject({
			ok: true,
			selection: null,
		});

		const { paragraphs, sequenceId } = (await api.cutTranscript(
			{},
		)) as Transcript;
		const [first, second] = paragraphs.flatMap(({ sentences }) => sentences);
		const store = useTranscriptStore.getState();
		store.select({ sequenceId, sentenceId: second.id });
		store.select({ sequenceId, sentenceId: first.id, extend: true });
		const selected = (await api.transcriptSelection({})) as Selection;
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
		const lapsed = (await api.transcriptSelection({})) as Selection;
		expect(lapsed.selection).toBeNull();
		expect(lapsed.hint).toContain("select it again");
	});
});
