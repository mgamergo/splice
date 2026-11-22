import { beforeEach, describe, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { ToggleMarkerCommand } from "@/commands/sequence/toggle-marker";
import type { EditorCore } from "@/core";

let editor: EditorCore;
let api: EditorApi;

const mainClips = () => editor.sequences.getActiveSequence().tracks.main.clips;

beforeEach(() => {
	editor = setUpEditor({
		tracks: {},
	});
	const sequence = editor.sequences.getActiveSequence();
	editor.timeline.updateTracks({
		...sequence.tracks,
		main: { ...sequence.tracks.main, clips: [videoClip({ id: "rec", start: 0, duration: 30 })] },
	});
	api = new EditorApi(editor);
});

describe("EditorApi.apply", () => {
	test("applies all ops as one undo step and bumps the revision once", () => {
		const result = api.apply({
			expectedRevision: 0,
			label: "Rough cut",
			ops: [
				{ op: "ripple_delete", ranges: [{ start: { seconds: 20 }, end: { seconds: 25 } }] },
				{ op: "ripple_delete", ranges: [{ start: { seconds: 2 }, end: { seconds: 5 } }] },
				{ op: "add_marker", at: { seconds: 2 }, note: "Intro: 1 take removed" },
			],
		});

		expect(result).toMatchObject({ ok: true, revision: 1 });
		expect(mainClips().map((clip) => [clip.startTime, clip.duration])).toEqual([
			[s(0), s(2)],
			[s(2), s(15)],
			[s(17), s(5)],
		]);
		expect(editor.sequences.getActiveSequence().markers).toEqual([
			{ time: s(2), note: "Intro: 1 take removed" },
		]);

		editor.command.undo();
		expect(mainClips().map((clip) => [clip.startTime, clip.duration])).toEqual([[s(0), s(30)]]);
		expect(editor.sequences.getActiveSequence().markers).toEqual([]);
	});

	test("rejects a stale revision with the current digest and changes nothing", () => {
		// The creator adds a marker while the agent is planning.
		editor.command.execute({ command: new ToggleMarkerCommand(s(1)) });

		const result = api.apply({
			expectedRevision: 0,
			label: "Remove pause",
			ops: [{ op: "ripple_delete", ranges: [{ start: { seconds: 2 }, end: { seconds: 3 } }] }],
		});

		expect(result).toMatchObject({ ok: false, code: "REVISION_CONFLICT", revision: 1 });
		expect(result.ok ? "" : result.digest).toContain("revision 1");
		expect(mainClips()).toHaveLength(1);
	});

	test("rolls back earlier ops when a later op is invalid", () => {
		const result = api.apply({
			expectedRevision: 0,
			label: "Bad batch",
			ops: [
				{ op: "ripple_delete", ranges: [{ start: { seconds: 2 }, end: { seconds: 3 } }] },
				{ op: "delete", clipIds: ["does-not-exist"] },
			],
		});

		expect(result).toMatchObject({ ok: false, code: "INVALID_OP", revision: 0 });
		expect(mainClips().map((clip) => [clip.startTime, clip.duration])).toEqual([[s(0), s(30)]]);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("rejects malformed requests before touching the editor", () => {
		const result = api.apply({ expectedRevision: 0, label: "x", ops: [{ op: "explode" }] });
		expect(result).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
		expect(api.getRevision()).toBe(0);
	});

	test("razor cuts every clip under the playhead time and ignores the ripple toggle", () => {
		editor.command.isRippleEnabled = true;
		const result = api.apply({
			expectedRevision: 0,
			label: "Cut",
			ops: [{ op: "razor", at: { seconds: 10 } }],
		});
		expect(result).toMatchObject({ ok: true });
		expect(mainClips().map((clip) => [clip.startTime, clip.duration])).toEqual([
			[s(0), s(10)],
			[s(10), s(20)],
		]);
		expect(editor.command.isRippleEnabled).toBe(true);
	});
});

describe("EditorApi undo and redo", () => {
	test("redo rebuilds ops that depend on clips created earlier in the batch", () => {
		api.apply({
			expectedRevision: 0,
			label: "Two cuts",
			ops: [
				{ op: "razor", at: { seconds: 10 } },
				{ op: "razor", at: { seconds: 20 } },
			],
		});
		const spans = () => mainClips().map((clip) => [clip.startTime, clip.duration]);
		const afterApply = spans();
		expect(afterApply).toHaveLength(3);

		editor.command.undo();
		editor.command.redo();
		expect(spans()).toEqual(afterApply);
	});

	test("redo ignores the creator's ripple toggle, like apply does", () => {
		editor.command.isRippleEnabled = true;
		api.apply({
			expectedRevision: 0,
			label: "Remove pause",
			ops: [{ op: "ripple_delete", ranges: [{ start: { seconds: 2 }, end: { seconds: 5 } }] }],
		});
		const afterApply = mainClips().map((clip) => [clip.startTime, clip.duration]);

		editor.command.undo();
		editor.command.redo();
		expect(mainClips().map((clip) => [clip.startTime, clip.duration])).toEqual(afterApply);
	});

	test("ripple delete drops removed clips from the selection", () => {
		editor.timeline.updateTracks({
			...editor.sequences.getActiveSequence().tracks,
			main: {
				...editor.sequences.getActiveSequence().tracks.main,
				clips: [videoClip({ id: "a", start: 0, duration: 5 }), videoClip({ id: "b", start: 5, duration: 5 })],
			},
		});
		const trackId = editor.sequences.getActiveSequence().tracks.main.id;
		editor.selection.setSelectedClips({
			clips: [
				{ trackId, clipId: "a" },
				{ trackId, clipId: "b" },
			],
		});

		api.apply({
			expectedRevision: api.getRevision(),
			label: "Remove first take",
			ops: [{ op: "ripple_delete", ranges: [{ start: { seconds: 0 }, end: { seconds: 5 } }] }],
		});

		expect(editor.selection.getSnapshot().selectedClips).toEqual([{ trackId, clipId: "b" }]);
	});
});

describe("EditorApi.getDigest", () => {
	test("describes tracks, clips with source ranges, markers and the revision", () => {
		const digest = api.getDigest();
		expect(digest).toContain("revision 0");
		expect(digest).toContain('V1 video');
		expect(digest).toContain('[rec video "rec" 0.00–30.00 (src 0.00–30.00)]');
		expect(digest).toContain("markers: (none)");
	});
});
