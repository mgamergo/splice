import { afterEach, describe, expect, mock, test } from "bun:test";
import { CAPTION_TRACK_NAME } from "@/agent/captions";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { useCaptionsStore } from "@/captions/store";
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
			word(4, 4.3, "Then"),
			word(4.35, 4.7, "next"),
			word(4.75, 5, "js"),
			word(5.05, 5.4, "again."),
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
	return { editor, api: new EditorApi(editor) };
}

type Listed = {
	ok: true;
	revision: number;
	cues: Array<{ id: string; text: string; correctedBy?: string }>;
};

afterEach(() => {
	useCaptionsStore.setState(initialCaptionsState, true);
});

describe("Horizontal captions through the editor API", () => {
	test("captions_add stores the words as SRT captions, never a burned-in track", async () => {
		const { editor, api } = horizontalEditor();
		const result = api.addCaptions({
			expectedRevision: api.getRevision(),
			sources,
		});
		expect(result).toMatchObject({ ok: true, captionCount: 2 });
		expect(editor.project.getActive().captions?.sources).toEqual(sources);
		const sequence = editor.sequences.getActiveSequence();
		expect(
			sequence.tracks.overlay.some(({ name }) => name === CAPTION_TRACK_NAME),
		).toBe(false);
		const listed = (await api.captionCues({})) as Listed;
		expect(listed.cues.map(({ text }) => text)).toEqual([
			"Open next js.",
			"Then next js again.",
		]);
	});

	test("corrects one cue, then the project, and undo brings the words back", async () => {
		const { editor, api } = horizontalEditor();
		api.addCaptions({ expectedRevision: api.getRevision(), sources });
		const listed = (await api.captionCues({})) as Listed;

		const stale = await api.correctCaption({
			expectedRevision: listed.revision - 1,
			cueId: listed.cues[0].id,
			text: "Open Next.js.",
		});
		expect(stale).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });

		const cue = await api.correctCaption({
			expectedRevision: listed.revision,
			cueId: listed.cues[0].id,
			text: "Open Next.js.",
		});
		expect(cue).toMatchObject({ ok: true, scope: "cue" });
		let cues = ((await api.captionCues({})) as Listed).cues;
		expect(cues.map(({ text }) => text)).toEqual([
			"Open Next.js.",
			"Then next js again.",
		]);

		const project = await api.correctCaption({
			expectedRevision: api.getRevision(),
			cueId: cues[1].id,
			text: "Then Next.js again.",
			scope: "project",
		});
		expect(project).toMatchObject({
			ok: true,
			replaced: { from: "next js", to: "Next.js" },
		});
		cues = ((await api.captionCues({})) as Listed).cues;
		expect(cues.map(({ text, correctedBy }) => [text, correctedBy])).toEqual([
			["Open Next.js.", "cue"],
			["Then Next.js again.", "project"],
		]);

		editor.command.undo();
		editor.command.undo();
		cues = ((await api.captionCues({})) as Listed).cues;
		expect(cues.map(({ text }) => text)).toEqual([
			"Open next js.",
			"Then next js again.",
		]);
	});

	test("a spelling correction is saved through splice and applies at once", async () => {
		const { api } = horizontalEditor();
		api.addCaptions({ expectedRevision: api.getRevision(), sources });
		const saveSpelling = mock(async (spelling: { from: string; to: string }) => {
			useCaptionsStore.setState({ spellings: [spelling] });
		});
		useCaptionsStore.setState({ saveSpelling, spellingsLoaded: true });
		const listed = (await api.captionCues({})) as Listed;
		const result = await api.correctCaption({
			expectedRevision: listed.revision,
			cueId: listed.cues[1].id,
			text: "Then NextJS again.",
			scope: "spelling",
		});
		expect(result).toMatchObject({ ok: true, scope: "spelling" });
		expect(saveSpelling).toHaveBeenCalledWith({ from: "next js", to: "NextJS" });
		// Spellings don't enter the project, so the revision stays.
		expect(api.getRevision()).toBe(listed.revision);
		const cues = ((await api.captionCues({})) as Listed).cues;
		expect(cues.map(({ text }) => text)).toEqual([
			"Open NextJS.",
			"Then NextJS again.",
		]);
	});

	test("an unknown cue or a Short project is refused", async () => {
		const { editor, api } = horizontalEditor();
		api.addCaptions({ expectedRevision: api.getRevision(), sources });
		expect(
			await api.correctCaption({
				expectedRevision: api.getRevision(),
				cueId: "rec:99-100",
				text: "x",
			}),
		).toMatchObject({ ok: false, code: "INVALID_OP" });
		const project = editor.project.getActive();
		editor.project.setActiveProject({
			project: { ...project, settings: { ...project.settings, format: "short" } },
		});
		expect(await api.captionCues({})).toMatchObject({
			ok: false,
			code: "INVALID_OP",
		});
	});
});
