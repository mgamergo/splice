import { expect, test } from "bun:test";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { EditorApi } from "@/agent/editor-api";
import type { ApplyRequest } from "@splice/bridge/ops";

const time = (seconds: number) => ({ seconds });
const range = (start: number, end: number) => ({
	start: time(start),
	end: time(end),
});

function fixture() {
	const editor = setUpEditor({
		tracks: {
			main: {
				id: "v1",
				name: "V1",
				type: "video",
				hidden: false,
				muted: false,
				clips: [
					videoClip({ id: "setup", start: 0, duration: 2 }),
					videoClip({ id: "detail", start: 2, duration: 2, trimStart: 2 }),
					videoClip({ id: "payoff", start: 4, duration: 2, trimStart: 4 }),
				],
			},
			overlay: [
				{
					id: "v2",
					name: "V2",
					type: "video",
					hidden: false,
					muted: false,
					clips: [videoClip({ id: "overlay", start: 4, duration: 2 })],
				},
			],
		},
	});
	editor.save.pause();
	const api = new EditorApi(editor);
	const sequence = () => editor.sequences.getActiveSequence();
	const request = {
		sequenceId: sequence().id,
		expectedRevision: api.getRevision(),
		label: "Revise the detail",
		scope: range(2, 4),
	};
	return { editor, api, sequence, request };
}

test("dry run reports the gap at a selected passage and keeps state and history intact", () => {
	const { editor, api, sequence, request } = fixture();
	const before = sequence();
	const project = editor.project.getActive();
	let notifications = 0;
	const unsubscribe = editor.sequences.subscribe(() => {
		notifications++;
	});
	const edit: ApplyRequest = {
		...request,
		ops: [{ op: "delete", clipIds: ["detail"] }],
	};
	try {
		expect(api.previewOps(edit)).toMatchObject({
			ok: true,
			revision: request.expectedRevision,
			impact: {
				affectedRange: { start: 2, end: 4 },
				outsideScopeUntouched: true,
				adjacentTransitions: {
					start: {
						before: {
							left: { clipId: "setup" },
							right: { clipId: "detail" },
							gapSeconds: 0,
						},
						after: {
							left: { clipId: "setup" },
							right: { clipId: "payoff" },
							gapSeconds: 2,
						},
					},
				},
				newGapsAndJumpCuts: [{ gapSeconds: 2, jumpCut: false }],
			},
		});
		expect(sequence()).toBe(before);
		expect(editor.project.getActive()).toBe(project);
		expect(notifications).toBe(0);
		expect(editor.command.canUndo()).toBe(false);
		expect(api.apply(edit)).toMatchObject({
			ok: true,
			impact: { outsideScopeUntouched: true },
		});
		expect(notifications).toBe(1);
		expect(sequence().tracks.main.clips).toEqual([
			before.tracks.main.clips[0],
			before.tracks.main.clips[2],
		]);
		editor.command.undo();
		expect(sequence()).toBe(before);
		editor.command.redo();
		expect(sequence().tracks.main.clips.map(({ id }) => id)).toEqual([
			"setup",
			"payoff",
		]);
	} finally {
		unsubscribe();
	}
});

test("scope refuses a ripple shift and reports its new jump cut before an authorized apply", () => {
	const { api, request, sequence } = fixture();
	const before = sequence();
	const edit: ApplyRequest = {
		...request,
		ops: [{ op: "ripple_delete", ranges: [range(2, 4)] }],
	};
	const impact = {
		outsideScopeUntouched: false,
		affectedRange: { start: 2, end: 6 },
		newGapsAndJumpCuts: [{ gapSeconds: 0, jumpCut: true }],
	};
	expect(api.previewOps(edit)).toMatchObject({ ok: true, impact });
	expect(api.apply(edit)).toMatchObject({ code: "OUTSIDE_SCOPE", impact });
	expect(sequence()).toBe(before);
	expect(api.apply({ ...edit, allowOutsideScope: true })).toMatchObject({
		ok: true,
		impact,
	});
	expect(api.previewOps(edit)).toMatchObject({ code: "REVISION_CONFLICT" });
});

test("scope checks overlay clips and marker ranges as well as V1", () => {
	const { api, request, sequence } = fixture();
	const before = sequence();
	expect(
		api.apply({ ...request, ops: [{ op: "delete", clipIds: ["overlay"] }] }),
	).toMatchObject({
		code: "OUTSIDE_SCOPE",
		impact: { affectedRange: { start: 4, end: 6 } },
	});
	const edit: ApplyRequest = {
		...request,
		ops: [
			{ op: "add_marker", at: time(2), note: "In scope" },
			{
				op: "add_marker",
				at: time(3),
				duration: time(2),
				note: "Crosses the end",
			},
		],
	};
	expect(api.apply(edit)).toMatchObject({ code: "OUTSIDE_SCOPE" });
	expect(sequence()).toBe(before);
	expect(api.apply({ ...edit, ops: edit.ops.slice(0, 1) })).toMatchObject({
		ok: true,
	});
	expect(sequence().markers).toHaveLength(1);
});
