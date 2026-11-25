import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import { deliveryFingerprint, takeDeliverySnapshot } from "@/export/deliver";
import type { ProjectItem } from "@/media/types";
import { buildDefaultSequence } from "@/timeline/sequences";
import { normalizeMarkers, storageService } from "@/services/storage/service";
import { ApprovalApi } from "../api";
import {
	captureApproval,
	checkpointDeliverySnapshot,
	commitApproval,
	dismissIssue,
	finalizeCut,
	latestCheckpoint,
	parseProjectApproval,
} from "../checkpoint";
import { restoreCheckpoint } from "../playback";
import {
	approvedIssues,
	hasUnavailableExportMedia,
	reviewState,
	sinceApprovalSummary,
} from "../review";

const initialCaptionsState = useCaptionsStore.getState();

beforeEach(() => {
	spyOn(storageService, "saveProject").mockResolvedValue(undefined);
});

afterEach(() => {
	mock.restore();
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
		url: "/splice/media/Day%201/rec.mov",
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
			lastModified: 0,
		},
	};
}

function availableRecording() {
	spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(null, {
			headers: { "content-length": "100" },
		}),
	);
}

function setUp(): {
	editor: EditorCore;
	api: EditorApi;
	approval: ApprovalApi;
} {
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
	test("a rejected project write fails finalize and a retry saves the checkpoint", async () => {
		const { editor, approval, api } = setUp();
		const save = spyOn(storageService, "saveProject")
			.mockRejectedValueOnce(new Error("Quota exceeded"))
			.mockRejectedValueOnce(new Error("Transaction aborted"))
			.mockResolvedValue(undefined);

		await expect(finalizeCut({ editor, origin: "editor" })).rejects.toThrow(
			"Quota exceeded",
		);
		expect(editor.project.getActive().approval).toBeUndefined();
		expect(
			await approval.finalizeCut({ expectedRevision: api.getRevision() }),
		).toMatchObject({
			ok: false,
			code: "INVALID_OP",
			message: expect.stringContaining("Transaction aborted"),
		});
		expect(editor.project.getActive().approval).toBeUndefined();

		const result = await finalizeCut({ editor, origin: "editor" });
		expect(save.mock.lastCall?.[0].project.approval?.checkpoints).toEqual([
			result.checkpoint,
		]);
		expect(editor.project.getActive().approval?.checkpoints).toEqual([
			result.checkpoint,
		]);
	});

	test("serializes finalize with autosave and publishes the checkpoint only after its write", async () => {
		const { editor } = setUp();
		const { promise: autosave, resolve: finishAutosave } =
			Promise.withResolvers<void>();
		const { promise: checkpointWrite, resolve: finishCheckpoint } =
			Promise.withResolvers<void>();
		const { promise: checkpointStarted, resolve: startCheckpoint } =
			Promise.withResolvers<void>();
		const save = spyOn(storageService, "saveProject")
			.mockImplementationOnce(() => autosave)
			.mockImplementationOnce(() => {
				startCheckpoint();
				return checkpointWrite;
			})
			.mockResolvedValue(undefined);

		const saving = editor.project.saveCurrentProject();
		const approving = finalizeCut({ editor, origin: "editor" });
		await Promise.resolve();
		expect(save).toHaveBeenCalledTimes(1);
		finishAutosave();
		await saving;
		await checkpointStarted;
		expect(editor.project.getActive().approval).toBeUndefined();

		const laterAutosave = editor.project.saveCurrentProject();
		finishCheckpoint();
		const { checkpoint } = await approving;
		await laterAutosave;
		expect(save).toHaveBeenCalledTimes(3);
		expect(save.mock.lastCall?.[0].project.approval?.checkpoints).toEqual([
			checkpoint,
		]);
	});

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
		const snapshot = checkpointDeliverySnapshot({
			editor,
			checkpoint: checkpoint!,
		});
		expect(await deliveryFingerprint(snapshot)).toBe(checkpoint!.fingerprint);

		// Approving the same edit again keeps the one checkpoint.
		const again = await approval.finalizeCut({
			expectedRevision: api.getRevision(),
		});
		expect(again).toMatchObject({ ok: true, saved: false });
		expect(editor.project.getActive().approval?.checkpoints).toHaveLength(1);
	});

	test("reapproval saves a marker-only change even when the MP4 and SRT match", async () => {
		const { editor, approval, api } = setUp();
		const first = await finalizeCut({ editor, origin: "editor" });
		const sequence = editor.sequences.getActiveSequence();
		editor.sequences.setSequences({
			sequences: [{ ...sequence, markers: [{ time: s(1), note: "Intro" }] }],
		});
		expect(await approval.checkpointStatus()).toMatchObject({
			matchesApproved: false,
		});
		const second = await approval.finalizeCut({
			expectedRevision: api.getRevision(),
		});
		expect(second).toMatchObject({ ok: true, saved: true });
		const { checkpoints } = editor.project.getActive().approval!;
		expect(checkpoints).toHaveLength(2);
		expect(checkpoints[1].fingerprint).toBe(first.checkpoint.fingerprint);
		expect(checkpoints[1].markers).toEqual([{ time: s(1), note: "Intro" }]);
	});

	test("a captured export keeps its approval, media and SRT when editing continues", async () => {
		const { editor, api } = setUp();
		availableRecording();
		const capture = captureApproval({ editor, origin: "export" });
		const committing = commitApproval({ editor, capture });
		rippleDelete({ editor, api });
		editor.media.setProjectItems({ projectItems: [recording({ size: 200 })] });
		const { checkpoint, snapshot } = await committing;
		expect(checkpoint.revision).toBe(0);
		expect(snapshot.source.checkpointId).toBe(checkpoint.id);
		expect(snapshot.scene.tracks.main.clips).toHaveLength(2);
		expect(snapshot.scene.projectItems[0].file.size).toBe(100);
		expect(snapshot.srt).toContain("Then save.");
		expect(editor.sequences.getActiveSequence().tracks.main.clips).toHaveLength(
			1,
		);
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
					summary: "1 clip change, 1 caption change",
				},
			],
		});

		const checkpoint = latestCheckpoint({
			project: editor.project.getActive(),
			sequenceId: editor.sequences.getActiveSequence().id,
		})!;
		const revision = api.getRevision();
		availableRecording();
		expect(await restoreCheckpoint({ editor, checkpoint })).toBe(true);
		expect(api.getRevision()).toBe(revision + 1);
		expect(reviewState({ editor }).comparison?.identical).toBe(true);
		editor.command.undo();
		expect(reviewState({ editor }).comparison?.identical).toBe(false);
	});

	test("keeps an imported title image for old checkpoints and validates restore after reopen", async () => {
		const { editor } = setUp();
		const project = editor.project.getActive();
		editor.project.setActiveProject({
			project: {
				...project,
				metadata: { ...project.metadata, thumbnail: "existing" },
			},
		});
		spyOn(storageService, "saveProjectItem").mockResolvedValue(undefined);
		const remove = spyOn(storageService, "deleteProjectItem").mockResolvedValue(
			undefined,
		);
		const image = await editor.media.addProjectItem({
			projectId: project.metadata.id,
			projectItem: {
				name: "Title",
				type: "image",
				file: new File(["title"], "title.png", { type: "image/png" }),
				url: "blob:title",
			},
		});
		if (!image) throw new Error("Expected title image");
		const { tracks } = editor.sequences.getActiveSequence();
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: [
					{
						...videoClip({ id: "title", start: 0, duration: 4 }),
						type: "image",
						mediaId: image.id,
					},
				],
			},
		});
		const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
		editor.timeline.updateTracks({
			...tracks,
			main: { ...tracks.main, clips: [] },
		});
		await finalizeCut({ editor, origin: "editor" });
		editor.media.removeProjectItem({
			projectId: project.metadata.id,
			id: image.id,
		});
		expect(remove).not.toHaveBeenCalled();

		const saved = editor.project.getActive();
		spyOn(storageService, "loadProject").mockResolvedValue({ project: saved });
		const loadMedia = spyOn(
			storageService,
			"loadAllProjectItems",
		).mockResolvedValue([image]);
		await editor.project.loadProject({ id: project.metadata.id });
		expect(await restoreCheckpoint({ editor, checkpoint })).toBe(true);
		expect(
			editor.sequences.getActiveSequence().tracks.main.clips[0],
		).toMatchObject({ mediaId: image.id });

		loadMedia.mockResolvedValue([]);
		await editor.project.loadProject({ id: project.metadata.id });
		await expect(restoreCheckpoint({ editor, checkpoint })).rejects.toThrow(
			"is unavailable",
		);
		expect(editor.sequences.getActiveSequence().tracks.main.clips).toEqual([]);
	});

	test("restoring the approved cut restores the reusable spellings it used", async () => {
		const { editor } = setUp();
		const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
		useCaptionsStore.setState({
			spellings: [{ from: "settings", to: "preferences" }],
		});
		expect(takeDeliverySnapshot({ editor }).srt).toContain("preferences");
		availableRecording();
		expect(await restoreCheckpoint({ editor, checkpoint })).toBe(true);
		expect(takeDeliverySnapshot({ editor }).srt).toBe(checkpoint.srt);
		editor.command.undo();
		expect(takeDeliverySnapshot({ editor }).srt).toContain("preferences");
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
		expect(await approval.issuesList({ includeDismissed: true })).toMatchObject(
			{
				unresolved: 0,
				dismissed: 1,
			},
		);

		// Cutting more changes what changed since approval.
		rippleDelete({ editor, api, start: 3, end: 4 });
		expect(
			reviewState({ editor }).unresolved.map(({ kind }) => kind),
		).toContain("changed-since-approval");
	});
	test("another source range at the same placement invalidates a dismissal", async () => {
		const { editor } = setUp();
		await finalizeCut({ editor, origin: "editor" });
		const sequence = editor.sequences.getActiveSequence();
		const trim = (time: number) =>
			editor.sequences.setSequences({
				sequences: [
					{
						...sequence,
						tracks: {
							...sequence.tracks,
							main: {
								...sequence.tracks.main,
								clips: [
									{ ...sequence.tracks.main.clips[0], trimStart: s(time) },
									sequence.tracks.main.clips[1],
								],
							},
						},
					},
				],
			});
		trim(0.1);
		const issue = reviewState({ editor }).unresolved[0];
		dismissIssue({
			editor,
			issueId: issue.id,
			evidence: issue.evidence,
			by: "creator",
		});
		expect(reviewState({ editor }).unresolved).toHaveLength(0);
		trim(0.2);
		expect(reviewState({ editor }).unresolved[0]?.evidence).not.toBe(
			issue.evidence,
		);
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

	test("approved export sees missing footage that the current edit no longer uses", async () => {
		const { editor, api } = setUp();
		const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
		rippleDelete({ editor, api, start: 0, end: 8 });
		editor.media.setProjectItems({ projectItems: [] });
		expect(
			reviewState({ editor }).issues.some(
				({ kind }) => kind === "missing-footage",
			),
		).toBe(false);
		expect(
			approvedIssues({
				editor,
				checkpoint,
				sequence: editor.sequences.getActiveSequence(),
			}),
		).toContainEqual(expect.objectContaining({ kind: "missing-footage" }));
	});

	test("dismissed missing media still blocks both export choices", async () => {
		const { editor } = setUp();
		const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
		editor.media.setProjectItems({
			projectItems: [recording({ missing: true })],
		});
		const issue = reviewState({ editor }).issues.find(
			({ kind }) => kind === "missing-footage",
		);
		if (!issue) throw new Error("Expected missing footage");
		dismissIssue({
			editor,
			issueId: issue.id,
			evidence: issue.evidence,
			by: "creator",
		});
		const current = reviewState({ editor });
		const approved = approvedIssues({
			editor,
			checkpoint,
			sequence: current.sequence,
		});
		expect(current.unresolved).toEqual([]);
		expect(approved).toContainEqual(
			expect.objectContaining({ dismissed: expect.anything() }),
		);
		expect(
			hasUnavailableExportMedia({ issues: current.issues, approved: false }),
		).toBe(true);
		expect(
			hasUnavailableExportMedia({ issues: approved, approved: true }),
		).toBe(true);

		const capture = captureApproval({ editor, origin: "export" });
		await expect(commitApproval({ editor, capture })).rejects.toThrow(
			"is unavailable",
		);
		expect(editor.project.getActive().approval?.checkpoints).toEqual([
			checkpoint,
		]);
	});

	test("summarizes a dismissed same-path replacement and accepts a byte-identical relink", async () => {
		const { editor, approval } = setUp();
		const item = recording();
		const { file } = item;
		if (file instanceof File) throw new Error("Expected disk recording");
		const original = { ...item, file: { ...file, contentHash: "original" } };
		editor.media.setProjectItems({ projectItems: [original] });
		await finalizeCut({ editor, origin: "editor" });

		editor.media.setProjectItems({
			projectItems: [
				{ ...item, file: { ...file, contentHash: "replacement" } },
			],
		});
		const changed = reviewState({ editor }).issues.find(
			({ kind }) => kind === "changed-footage",
		);
		if (!changed) throw new Error("Expected changed footage");
		dismissIssue({
			editor,
			issueId: changed.id,
			evidence: changed.evidence,
			by: "creator",
		});
		const review = reviewState({ editor });
		expect(review.comparison?.identical).toBe(true);
		expect(review.unresolved).toEqual([]);
		expect(sinceApprovalSummary(review)).toContain(
			"differs from the approved recording",
		);

		editor.media.setProjectItems({
			projectItems: [
				{
					...original,
					file: { ...original.file, path: "Moved/rec.mov", lastModified: 2000 },
				},
			],
		});
		expect(sinceApprovalSummary(reviewState({ editor }))).toContain(
			"No changes",
		);
		expect(await approval.checkpointStatus()).toMatchObject({
			matchesApproved: true,
		});
	});

	test("caption coverage dismissals ignore framing but detect source ranges and replacement bytes", () => {
		const { editor } = setUp();
		const item = recording();
		const { file } = item;
		if (file instanceof File) throw new Error("Expected disk recording");
		editor.media.setProjectItems({
			projectItems: [{ ...item, file: { ...file, contentHash: "original" } }],
		});
		editor.project.setActiveProject({
			project: { ...editor.project.getActive(), captions: undefined },
		});
		const issue = reviewState({ editor }).issues.find(
			({ kind }) => kind === "no-captions",
		);
		if (!issue) throw new Error("Expected missing captions");
		dismissIssue({
			editor,
			issueId: issue.id,
			evidence: issue.evidence,
			by: "creator",
		});
		const { tracks } = editor.sequences.getActiveSequence();
		const frame = ({ offset }: { offset: number }) =>
			editor.timeline.updateTracks({
				...tracks,
				main: {
					...tracks.main,
					clips: tracks.main.clips.map((clip) => ({
						...clip,
						params: { ...clip.params, opacity: 0.75 },
						trimStart: s(offset + (clip.id === "b" ? 10 : 0)),
					})),
				},
			});
		frame({ offset: 0 });
		expect(reviewState({ editor }).unresolved).toEqual([]);
		frame({ offset: 1 });
		expect(reviewState({ editor }).unresolved).toContainEqual(
			expect.objectContaining({ kind: "no-captions" }),
		);
		frame({ offset: 0 });
		editor.media.setProjectItems({
			projectItems: [
				{ ...item, file: { ...file, contentHash: "replacement" } },
			],
		});
		expect(reviewState({ editor }).unresolved).toContainEqual(
			expect.objectContaining({ kind: "no-captions" }),
		);
	});

	test("adding another audible clip invalidates a caption-coverage dismissal", () => {
		const { editor } = setUp();
		editor.project.setActiveProject({
			project: { ...editor.project.getActive(), captions: undefined },
		});
		const before = reviewState({ editor }).unresolved.find(
			({ kind }) => kind === "no-captions",
		);
		if (!before) throw new Error("Expected missing captions");
		dismissIssue({
			editor,
			issueId: before.id,
			evidence: before.evidence,
			by: "creator",
		});
		const sequence = editor.sequences.getActiveSequence();
		editor.timeline.updateTracks({
			...sequence.tracks,
			main: {
				...sequence.tracks.main,
				clips: [
					...sequence.tracks.main.clips,
					videoClip({ id: "new", start: 8, duration: 4 }),
				],
			},
		});
		expect(
			reviewState({ editor }).unresolved.find(
				({ kind }) => kind === "no-captions",
			)?.evidence,
		).not.toBe(before.evidence);
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
		expect(
			parseProjectApproval({ raw: undefined, parseMarkers: () => [] }),
		).toBe(undefined);
	});
});
