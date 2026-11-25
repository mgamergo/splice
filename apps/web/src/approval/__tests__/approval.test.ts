import { afterEach, describe, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import { deliveryFingerprint } from "@/export/deliver";
import type { ProjectItem } from "@/media/types";
import { buildDefaultSequence } from "@/timeline/sequences";
import { normalizeMarkers } from "@/services/storage/service";
import { ApprovalApi } from "../api";
import {
	checkpointDeliverySnapshot,
	dismissIssue,
	finalizeCut,
	latestCheckpoint,
	parseProjectApproval,
} from "../checkpoint";
import { restoreCheckpoint } from "../playback";
import { reviewState } from "../review";

const initialCaptionsState = useCaptionsStore.getState();

afterEach(() => {
	useCaptionsStore.setState(initialCaptionsState, true);
});

function recording({
	missing = false,
	size = 100,
}: {
	missing?: boolean;
	size?: number;
} = {}): ProjectItem {
	return {
		id: "rec",
		name: "rec",
		type: "video",
		duration: 60,
		hasAudio: true,
		missing,
		file: {
			kind: "disk",
			path: "Day 1/rec.mov",
			url: "/splice/media/Day%201/rec.mov",
			name: "rec.mov",
			type: "video/quicktime",
			size,
			lastModified: 1,
		},
	};
}

function setUp(): { editor: EditorCore; api: EditorApi; approval: ApprovalApi } {
	const { main } = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	const editor = setUpEditor({
		tracks: {
			main: {
				...main,
				clips: [
					videoClip({ id: "a", start: 0, duration: 4 }),
					videoClip({ id: "b", start: 4, duration: 4, trimStart: 10 }),
				],
			},
		},
	});
	editor.media.setProjectItems({ projectItems: [recording()] });
	editor.project.setActiveProject({
		project: {
			...editor.project.getActive(),
			captions: {
				sources: [
					{
						projectItemId: "rec",
						words: [
							{ start: 1, end: 1.4, text: "Open" },
							{ start: 1.5, end: 2, text: "settings." },
							{ start: 11, end: 11.5, text: "Then" },
							{ start: 11.6, end: 12, text: "save." },
						],
					},
				],
				cueEdits: [],
				replacements: [],
			},
		},
	});
	const api = new EditorApi(editor);
	return { editor, api, approval: new ApprovalApi({ editor, api }) };
}

/** Ripple deletes a range of the sequence through the editing API. */
function rippleDelete({
	editor,
	api,
	start = 4,
	end = 8,
}: {
	editor: EditorCore;
	api: EditorApi;
	start?: number;
	end?: number;
}) {
	const result = api.apply({
		sequenceId: editor.sequences.getActiveSequence().id,
		expectedRevision: api.getRevision(),
		label: "Cut",
		ops: [
			{
				op: "ripple_delete",
				ranges: [{ start: { seconds: start }, end: { seconds: end } }],
			},
		],
	});
	expect(result).toMatchObject({ ok: true });
}

describe("finalizing the cut", () => {
	test("saves the exact edit with the fingerprint an export would record", async () => {
		const { editor, approval, api } = setUp();
		const stale = await approval.finalizeCut({
			expectedRevision: api.getRevision() + 1,
		});
		expect(stale).toMatchObject({ ok: false, code: "REVISION_CONFLICT" });

		const result = await approval.finalizeCut({
			expectedRevision: api.getRevision(),
			note: "Looks right",
		});
		expect(result).toMatchObject({
			ok: true,
			saved: true,
			checkpoint: { origin: "agent", note: "Looks right" },
		});
		const checkpoint = latestCheckpoint({
			project: editor.project.getActive(),
			sequenceId: editor.sequences.getActiveSequence().id,
		});
		expect(checkpoint?.tracks.main.clips.map(({ id }) => id)).toEqual([
			"a",
			"b",
		]);
		const snapshot = checkpointDeliverySnapshot({ editor, checkpoint: checkpoint! });
		expect(await deliveryFingerprint(snapshot)).toBe(checkpoint!.fingerprint);

		// Approving the same edit again keeps the one checkpoint.
		const again = await approval.finalizeCut({
			expectedRevision: api.getRevision(),
		});
		expect(again).toMatchObject({ ok: true, saved: false });
		expect(editor.project.getActive().approval?.checkpoints).toHaveLength(1);
	});

	test("finalizing isn't an edit: undo never removes a checkpoint", async () => {
		const { editor, api } = setUp();
		rippleDelete({ editor, api });
		await finalizeCut({ editor, origin: "editor" });
		editor.command.undo();
		expect(editor.project.getActive().approval?.checkpoints).toHaveLength(1);
	});
});

describe("after approval", () => {
	test("status and compare show what changed, and restoring is one undoable edit", async () => {
		const { editor, api, approval } = setUp();
		await finalizeCut({ editor, origin: "editor" });
		expect(await approval.checkpointStatus()).toMatchObject({
			ok: true,
			matchesApproved: true,
			changedPassages: 0,
		});

		rippleDelete({ editor, api });
		expect(await approval.checkpointStatus()).toMatchObject({
			matchesApproved: false,
			changedPassages: 1,
		});
		const compared = await approval.checkpointCompare({});
		expect(compared).toMatchObject({
			ok: true,
			identical: false,
			passages: [
				{
					start: 4,
					end: 4,
					approvedStart: 4,
					approvedEnd: 8,
					summary: "1 clip change",
				},
			],
		});

		const checkpoint = latestCheckpoint({
			project: editor.project.getActive(),
			sequenceId: editor.sequences.getActiveSequence().id,
		})!;
		const revision = api.getRevision();
		expect(restoreCheckpoint({ editor, checkpoint })).toBe(true);
		expect(api.getRevision()).toBe(revision + 1);
		expect(reviewState({ editor }).comparison?.identical).toBe(true);
		editor.command.undo();
		expect(reviewState({ editor }).comparison?.identical).toBe(false);
	});

	test("a change since approval is an issue until dismissed, and comes back when it changes", async () => {
		const { editor, api, approval } = setUp();
		await finalizeCut({ editor, origin: "editor" });
		rippleDelete({ editor, api });
		const listed = (await approval.issuesList({})) as {
			issues: Array<{ id: string; kind: string; evidence: string }>;
		};
		const changed = listed.issues.find(
			({ kind }) => kind === "changed-since-approval",
		)!;
		expect(changed).toBeDefined();

		const wrong = await approval.dismissIssue({
			issueId: changed.id,
			evidence: "0000",
		});
		expect(wrong).toMatchObject({ ok: false, code: "INVALID_OP" });
		expect(
			await approval.dismissIssue({
				issueId: changed.id,
				evidence: changed.evidence,
			}),
		).toMatchObject({ ok: true, dismissal: { by: "agent" } });
		expect(reviewState({ editor }).unresolved).toEqual([]);
		expect(await approval.issuesList({ includeDismissed: true })).toMatchObject({
			unresolved: 0,
			dismissed: 1,
		});

		// Cutting more changes what changed since approval.
		rippleDelete({ editor, api, start: 3, end: 4 });
		expect(
			reviewState({ editor }).unresolved.map(({ kind }) => kind),
		).toContain("changed-since-approval");
	});
});

describe("review issues", () => {
	test("missing and changed recordings, flagged markers and long captions", async () => {
		const { editor } = setUp();
		await finalizeCut({ editor, origin: "editor" });
		editor.media.setProjectItems({ projectItems: [recording({ size: 200 })] });
		expect(reviewState({ editor }).unresolved.map(({ kind }) => kind)).toEqual([
			"changed-footage",
		]);

		editor.media.setProjectItems({
			projectItems: [recording({ missing: true })],
		});
		const sequence = editor.sequences.getActiveSequence();
		editor.sequences.setSequences({
			sequences: [
				{
					...sequence,
					markers: [
						{ time: s(2), note: "Review: is the zoom readable?" },
						{ time: s(3), note: "Nice bit" },
					],
				},
			],
		});
		const words = Array.from({ length: 30 }, (_, index) => ({
			start: index * 0.1,
			end: index * 0.1 + 0.08,
			text: "longword",
		}));
		editor.project.setActiveProject({
			project: {
				...editor.project.getActive(),
				captions: {
					sources: [{ projectItemId: "rec", words }],
					cueEdits: [
						{
							words: words.map((_, index) => ({
								projectItemId: "rec",
								index,
							})),
							text: "word ".repeat(40).trim(),
						},
					],
					replacements: [],
				},
			},
		});
		const kinds = reviewState({ editor }).unresolved.map(({ kind }) => kind);
		expect(kinds).toContain("missing-footage");
		expect(kinds).toContain("flagged");
		expect(kinds).toContain("caption-overlong");
		expect(kinds).not.toContain("changed-footage");
	});

	test("a dismissal lasts until the evidence changes", async () => {
		const { editor } = setUp();
		const sequence = editor.sequences.getActiveSequence();
		const flag = (note: string) =>
			editor.sequences.setSequences({
				sequences: [{ ...sequence, markers: [{ time: s(1), note }] }],
			});
		flag("TODO check the intro");
		const issue = reviewState({ editor }).unresolved.find(
			({ kind }) => kind === "flagged",
		)!;
		expect(issue.detail).toBe("TODO check the intro");
		dismissIssue({
			editor,
			issueId: issue.id,
			evidence: issue.evidence,
			by: "creator",
		});
		const flagged = () =>
			reviewState({ editor }).unresolved.filter(
				({ kind }) => kind === "flagged",
			);
		expect(flagged()).toEqual([]);
		flag("TODO check the intro again");
		expect(flagged()).toHaveLength(1);
	});
});

describe("saving approval with the project", () => {
	test("keeps good entries and drops ones that don't parse", async () => {
		const { editor } = setUp();
		await finalizeCut({ editor, origin: "editor" });
		const saved = JSON.parse(
			JSON.stringify(editor.project.getActive().approval),
		);
		saved.checkpoints.push({ id: "broken" });
		saved.dismissals.push({ issueId: "x" });
		const parsed = parseProjectApproval({
			raw: saved,
			parseMarkers: (raw) => normalizeMarkers({ raw }),
		});
		expect(parsed?.checkpoints).toHaveLength(1);
		expect(parsed?.dismissals).toEqual([]);
		expect(parseProjectApproval({ raw: undefined, parseMarkers: () => [] })).toBe(
			undefined,
		);
	});
});
