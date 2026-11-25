import { MEDIA_CONTENT_HEADER, MEDIA_VERSION_HEADER } from "@splice/bridge";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { BASE_STYLE } from "@splice/bridge/style";
import { StyleUpdateApi } from "@/agent/style-update";
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
import { findGraphicClip } from "@/agent/graphics";
import { isHookTrack } from "@/agent/short-hook";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { useCaptionsStore } from "@/captions/store";
import { UpdateClipsCommand } from "@/commands/timeline/clip/update-clips";
import type { EditorCore } from "@/core";
import { deliveryFingerprint, takeDeliverySnapshot } from "@/export/deliver";
import type { ProjectItem } from "@/media/types";
import { buildDefaultSequence } from "@/timeline/sequences";
import { IndexedDBAdapter } from "@/services/storage/indexeddb-adapter";
import type { ProjectItemData } from "@/services/storage/types";
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

function mockFootageFetch(
	respond: (...args: Parameters<typeof fetch>) => Promise<Response>,
) {
	spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(respond, { preconnect: fetch.preconnect }),
	);
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

function applyHighlight({ editor, api }: { editor: EditorCore; api: EditorApi }) {
	const result = api.graphicsApply({
		expectedRevision: api.getRevision(),
		graphics: [
			{
				kind: "highlight",
				projectItemId: "rec",
				action: 11,
				passage: { start: 10, end: 13 },
				target: { x: 0.2, y: 0.3, width: 0.1, height: 0.1 },
			},
		],
	});
	expect(result).toMatchObject({ ok: true, graphics: [{ status: "create" }] });
	const sequence = editor.sequences.getActiveSequence();
	const graphicId = sequence.graphics?.records[0]?.id;
	if (!graphicId) throw new Error("Expected a graphic");
	const placed = findGraphicClip({ tracks: sequence.tracks, graphicId });
	if (!placed) throw new Error("Expected a graphic clip");
	return { graphicId, ...placed };
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

	test("saves and restores a Short's style, caption placement and opening hook", async () => {
		const { editor, api, approval } = setUp();
		availableRecording();
		const project = editor.project.getActive();
		editor.project.setActiveProject({
			project: {
				...project,
				settings: {
					...project.settings,
					format: "short",
					canvasSize: { width: 720, height: 1280 },
					fps: { numerator: 60, denominator: 1 },
				},
			},
		});
		const revision = () => ({ expectedRevision: api.getRevision() });
		expect(api.setShortStyle({ ...revision(), style: "raw" })).toMatchObject({ ok: true });
		expect(api.addCaptions({
			...revision(),
			sources: project.captions?.sources,
		})).toMatchObject({ ok: true });
		expect(api.setShortCaptionPlacement({ ...revision(), position: "top" })).toMatchObject({ ok: true });
		expect(api.setShortHook({
			...revision(),
			hook: {
				text: "Find the switch",
				demonstrationStart: 2.5,
				evidence: {
					kind: "narration",
					projectItemId: "rec",
					time: 1.5,
					detail: "Open settings",
				},
			},
		})).toMatchObject({ status: "placed" });

		const result = await approval.finalizeCut(revision());
		expect(result).toMatchObject({ ok: true, checkpoint: { shortStyle: "raw" } });
		const saved = parseProjectApproval({
			raw: JSON.parse(JSON.stringify(editor.project.getActive().approval)),
			parseMarkers: (raw) => normalizeMarkers({ raw }),
		});
		const checkpoint = saved?.checkpoints[0];
		if (!checkpoint) throw new Error("Expected a saved checkpoint");
		expect(checkpoint.shortStyle).toBe("raw");
		expect(checkpoint.sequenceCaptions?.style?.position).toBe("top");
		expect(checkpoint.tracks.overlay.find(isHookTrack)?.clips[0]).toMatchObject({
			params: { content: "Find the switch" },
			shortHook: { evidence: { projectItemId: "rec", sourceTime: 1.5 } },
		});
		expect(checkpoint.srt).toContain("Open settings.");
		expect(checkpoint.srt).not.toContain("Find the switch");
		expect(await approval.checkpointStatus()).toMatchObject({ matchesApproved: true });

		api.setShortStyle({ ...revision(), style: "explainer" });
		api.setShortCaptionPlacement({ ...revision(), position: "bottom" });
		expect(reviewState({ editor }).comparison?.changes.map(({ label }) => label))
			.toContain("Short style");
		const snapshot = checkpointDeliverySnapshot({ editor, checkpoint });
		expect(snapshot.scene.canvasSize).toEqual({ width: 720, height: 1280 });
		expect(snapshot.scene.outputSize).toEqual({ width: 1080, height: 1920 });
		expect(snapshot.fps).toEqual({ numerator: 60, denominator: 1 });
		expect(await deliveryFingerprint(snapshot)).toBe(checkpoint.fingerprint);

		expect(await restoreCheckpoint({ editor, checkpoint })).toBe(true);
		expect(editor.project.getActive().settings.shortStyle).toBe("raw");
		expect(editor.sequences.getActiveSequence().captions?.style?.position).toBe("top");
		expect(await approval.checkpointStatus()).toMatchObject({ matchesApproved: true });
		editor.command.undo();
		expect(editor.project.getActive().settings.shortStyle).toBe("explainer");
		expect(editor.sequences.getActiveSequence().captions?.style?.position).toBe("bottom");
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
	test("an approved checkpoint keeps graphic clips and adjustments after reload", async () => {
		const { editor, api } = setUp();
		const { graphicId, trackId, clip } = applyHighlight({ editor, api });
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [
					{
						trackId,
						clipId: clip.id,
						patch: {
							params: { ...clip.params, "transform.positionX": 123 },
						},
					},
				],
			}),
		});
		await finalizeCut({ editor, origin: "editor" });
		const parsed = parseProjectApproval({
			raw: JSON.parse(JSON.stringify(editor.project.getActive().approval)),
			parseMarkers: (raw) => normalizeMarkers({ raw }),
		});
		const checkpoint = parsed?.checkpoints[0];
		if (!checkpoint) throw new Error("Expected the saved checkpoint");
		expect(checkpoint.graphics?.records[0]).toMatchObject({
			id: graphicId,
			action: { projectItemId: "rec", time: 11 },
			overrides: { position: { x: 123 } },
			placed: { clipId: clip.id },
		});

		const style = new StyleUpdateApi({
			editor,
			readDefaults: async () => ({
				...BASE_STYLE,
				revision: 2,
				values: {
					...BASE_STYLE.values,
					highlight: { ...BASE_STYLE.values.highlight, stroke: "#ff0000" },
				},
			}),
		});
		const preview = await style.preview();
		if (!preview) throw new Error("Expected a style preview");
		expect(await style.apply({
			request: { previewId: preview.id, expectedRevision: preview.revision },
		})).toMatchObject({ ok: true });
		expect(findGraphicClip({
			tracks: editor.sequences.getActiveSequence().tracks, graphicId,
		})?.clip.params.stroke).toBe("#ff0000");

		rippleDelete({ editor, api });
		expect(
			editor.sequences.getActiveSequence().graphics?.records[0],
		).toMatchObject({
			flags: [{ code: "action_missing" }],
		});
		const { scene } = checkpointDeliverySnapshot({ editor, checkpoint });
		const delivered = findGraphicClip({ tracks: scene.tracks, graphicId });
		expect(delivered?.clip.params["transform.positionX"]).toBe(123);

		availableRecording();
		expect(await restoreCheckpoint({ editor, checkpoint })).toBe(true);
		const restored = editor.sequences.getActiveSequence();
		expect(restored.styleDefaults?.revision).toBe(1);
		expect(editor.project.getActive().settings.styleDefaults?.revision).toBe(2);
		expect(restored.graphics).toEqual(checkpoint.graphics);
		expect(findGraphicClip({ tracks: restored.tracks, graphicId })).toEqual(
			delivered,
		);
		const current = buildDefaultSequence({ name: "Current cut", isMain: false });
		editor.sequences.setSequences({
			sequences: [...editor.sequences.getSequences(), current],
			activeSequenceId: current.id,
		});
		const restoredPreview = await style.preview();
		if (!restoredPreview) throw new Error("Expected a preview for the restored sequence");
		expect(restoredPreview).toMatchObject({ from: 1, defaults: { revision: 2 } });
		expect(await style.apply({
			request: { previewId: restoredPreview.id, expectedRevision: restoredPreview.revision },
		})).toMatchObject({ ok: true });
		const updated = editor.sequences.getSequences().find(({ id }) => id === restored.id);
		if (!updated) throw new Error("Missing restored sequence");
		expect(updated.styleDefaults).toBeUndefined();
		expect(editor.sequences.getActiveSequence()).toBe(current);
		expect(findGraphicClip({
			tracks: updated.tracks, graphicId,
		})?.clip.params.stroke).toBe("#ff0000");
		expect(await style.preview()).toBeNull();
	});

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

	test("verifies moves, retains approval and quarantines changes at the saved path", async () => {
		const { editor, api, approval } = setUp();
		const save = spyOn(storageService, "saveProjectItem").mockResolvedValue(
			undefined,
		);
		const item = recording();
		const { file } = item;
		if (file instanceof File) throw new Error("Expected disk recording");
		const originalHash = "a".repeat(64);
		const original = { ...item, file: { ...file, contentHash: originalHash } };
		editor.media.setProjectItems({ projectItems: [original] });
		applyHighlight({ editor, api });
		const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
		const tracks = editor.sequences.getActiveSequence().tracks;
		const movedPath = "Moved/rec.mov";
		let content = originalHash;
		let version = "copy";
		mockFootageFetch(async (...[input]) => {
			if (!String(input).endsWith(movedPath))
				return new Response(null, { status: 404 });
			return new Response(null, {
				headers: {
					"content-type": "video/quicktime",
					"content-length": "100",
					[MEDIA_CONTENT_HEADER]: content,
					[MEDIA_VERSION_HEADER]: version,
				},
			});
		});
		const first = editor.media.verifyRecordings();
		expect(editor.media.verifyRecordings()).toBe(first);
		expect(await first).toMatchObject([{ verification: "missing" }]);
		expect(
			await editor.media.relinkRecording({
				request: { projectItemId: "rec", path: movedPath },
			}),
		).toMatchObject({
			kind: "relinked",
			verification: "match",
			item: { id: "rec", path: movedPath },
		});
		expect(save).toHaveBeenCalledTimes(1);
		expect(editor.sequences.getActiveSequence().tracks).toBe(tracks);
		expect(editor.project.getActive().captions?.sources).toEqual(
			checkpoint.captions?.sources,
		);
		expect(await approval.checkpointStatus()).toMatchObject({
			matchesApproved: true,
		});

		content = "b".repeat(64);
		version = "replacement";
		expect(await editor.media.verifyRecordings()).toMatchObject([
			{ verification: "changed", item: { missing: true } },
		]);
		expect(sinceApprovalSummary(reviewState({ editor }))).toContain(
			"needs confirmation",
		);
		expect(await approval.checkpointStatus()).toMatchObject({
			matchesApproved: false,
		});
		expect(
			await editor.media.relinkRecording({
				request: { projectItemId: "rec", path: movedPath },
			}),
		).toEqual({
			kind: "confirmation-required",
			verification: "changed",
			version,
		});
		expect(save).toHaveBeenCalledTimes(1);
		const review = reviewState({ editor }).issues.filter(
			({ kind }) => kind === "replacement-passage",
		);
		expect(review).toMatchObject([
			{ start: 0, end: 4, title: "Review clip and captions" },
			{ start: 4, end: 8, title: "Review clip and captions" },
			{ title: "Review graphic evidence" },
		]);
	});

	test("commits replacement and invalidation together, preserving undo if the binding write fails", async () => {
		const { editor } = setUp();
		editor.save.stop();
		spyOn(storageService, "saveProject").mockRestore();
		const globals = { indexedDB: new IDBFactory(), IDBKeyRange };
		const previous = Object.keys(globals).map(
			(name) =>
				[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
		);
		for (const [name, value] of Object.entries(globals))
			Object.defineProperty(globalThis, name, { configurable: true, value });
		try {
			const item = recording();
			const { file } = item;
			if (file instanceof File) throw new Error("Expected disk recording");
			editor.media.setProjectItems({
				projectItems: [
					{
						...item,
						type: "audio",
						file: { ...file, path: "rec.wav", contentHash: "c".repeat(64) },
					},
				],
			});
			const projectId = editor.project.getActive().metadata.id;
			const legacy = new IndexedDBAdapter<ProjectItemData>({
				dbName: `splice-media-${projectId}`,
				storeName: "media-metadata",
			});
			await legacy.set({
				key: item.id,
				value: {
					id: item.id,
					name: item.name,
					type: "audio",
					size: file.size,
					lastModified: file.lastModified,
					diskPath: "rec.wav",
					diskContentHash: "c".repeat(64),
				},
			});
			expect(
				await storageService.loadAllProjectItems({ projectId }),
			).toMatchObject([{ id: item.id, file: { contentHash: "c".repeat(64) } }]);
			const { checkpoint } = await finalizeCut({ editor, origin: "editor" });
			const api = new EditorApi(editor);
			expect(
				api.apply({
					sequenceId: editor.sequences.getActiveSequence().id,
					expectedRevision: api.getRevision(),
					label: "Add marker",
					ops: [{ op: "add_marker", at: { seconds: 1 } }],
				}),
			).toMatchObject({ ok: true });
			const sequence = editor.sequences.getActiveSequence();
			const loudness = {
				targetLufs: -14,
				ceilingDbtp: -1,
				gainDb: 0,
				measuredLufs: -14,
				measuredTruePeakDbtp: -1,
				expectedLufs: -14,
				expectedTruePeakDbtp: -1,
				fingerprint: "original",
			};
			editor.sequences.setSequences({
				sequences: [{ ...sequence, mix: { loudness } }],
			});
			await editor.project.saveCurrentProject();
			expect(editor.command.canUndo()).toBe(true);
			const tracks = editor.sequences.getActiveSequence().tracks;
			// One second of mono PCM, served the same way as a Footage range.
			const wav = Buffer.alloc(44 + 16000);
			wav.write("RIFF");
			wav.writeUInt32LE(wav.length - 8, 4);
			wav.write("WAVEfmt ", 8);
			wav.writeUInt32LE(16, 16);
			wav.writeUInt16LE(1, 20);
			wav.writeUInt16LE(1, 22);
			wav.writeUInt32LE(8000, 24);
			wav.writeUInt32LE(16000, 28);
			wav.writeUInt16LE(2, 32);
			wav.writeUInt16LE(16, 34);
			wav.write("data", 36);
			wav.writeUInt32LE(wav.length - 44, 40);
			mockFootageFetch(
				async (...[, init]) =>
					new Response(init?.method === "HEAD" ? null : wav, {
						headers: {
							"content-type": "audio/wav",
							"content-length": String(wav.length),
							[MEDIA_CONTENT_HEADER]: "d".repeat(64),
							[MEDIA_VERSION_HEADER]: "v2",
						},
					}),
			);
			const request = { projectItemId: "rec", path: "rec.wav" };
			expect(await editor.media.verifyRecordings()).toMatchObject([
				{ verification: "changed" },
			]);
			expect(await editor.media.relinkRecording({ request })).toMatchObject({
				kind: "confirmation-required",
				version: "v2",
			});
			expect(
				await editor.media.relinkRecording({
					request: { ...request, replace: true, expectedVersion: "stale" },
				}),
			).toMatchObject({ kind: "confirmation-required", version: "v2" });
			const confirmed = { ...request, replace: true, expectedVersion: "v2" };
			const put = IDBObjectStore.prototype.put;
			const writes: string[] = [];
			const failBindingWrite = spyOn(
				IDBObjectStore.prototype,
				"put",
			).mockImplementation(function (
				this: IDBObjectStore,
				...args: Parameters<IDBObjectStore["put"]>
			) {
				writes.push(this.name);
				if (this.name === "recordings")
					throw new Error("Failed to write replacement");
				return put.apply(this, args);
			});
			try {
				await expect(
					editor.media.relinkRecording({ request: confirmed }),
				).rejects.toThrow("Failed to write replacement");
			} finally {
				failBindingWrite.mockRestore();
			}
			expect(writes).toEqual(["projects", "recordings"]);
			expect(editor.command.canUndo()).toBe(true);
			expect(editor.project.getActive().captions?.sources).toEqual(
				checkpoint.captions?.sources,
			);
			const persisted = (await storageService.loadProject({ id: projectId }))
				?.project;
			expect(persisted?.captions?.sources).toEqual(
				checkpoint.captions?.sources,
			);
			expect(persisted?.sequences[0].mix?.loudness).toEqual(loudness);
			expect(editor.sequences.getActiveSequence().mix?.loudness).toEqual(
				loudness,
			);
			expect(
				(await storageService.loadProjectItem({ projectId, id: "rec" }))?.file,
			).toMatchObject({ contentHash: "c".repeat(64) });
			expect(
				await editor.media.relinkRecording({
					request: confirmed,
				}),
			).toMatchObject({
				kind: "relinked",
				verification: "changed",
				item: { id: "rec", missing: false, duration: 1 },
			});
			expect(editor.sequences.getActiveSequence().tracks).toBe(tracks);
			expect(editor.project.getActive().captions?.sources).toEqual([]);
			expect(editor.command.canUndo()).toBe(false);
			const replaced = (await storageService.loadProject({ id: projectId }))
				?.project;
			expect(replaced?.captions?.sources).toEqual([]);
			expect(replaced?.sequences[0].mix?.loudness).toBeUndefined();
			expect(
				editor.sequences.getActiveSequence().mix?.loudness,
			).toBeUndefined();
			expect(
				await storageService.loadAllProjectItems({ projectId }),
			).toMatchObject([{ id: item.id, file: { contentHash: "d".repeat(64) } }]);
			expect(checkpoint.captions?.sources).toHaveLength(1);
			expect(approvedIssues({ editor, checkpoint })).toContainEqual(
				expect.objectContaining({ kind: "changed-footage" }),
			);
			expect(
				reviewState({ editor }).issues.filter(
					({ kind }) => kind === "replacement-passage",
				),
			).toHaveLength(2);
		} finally {
			for (const [name, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			}
		}
	});

	test("backfills a legacy recording in place and keeps its fingerprint if it goes missing", async () => {
		const { editor } = setUp();
		const original = recording();
		const save = spyOn(storageService, "saveProjectItem").mockResolvedValue(
			undefined,
		);
		editor.media.setProjectItems({ projectItems: [original] });
		let gone = false;
		mockFootageFetch(async (...[input]) =>
			gone && String(input).endsWith("Day%201/rec.mov")
				? new Response(null, { status: 404 })
				: new Response(null, {
						headers: {
							"content-type": "video/quicktime",
							"content-length": "100",
							[MEDIA_CONTENT_HEADER]: "a".repeat(64),
							[MEDIA_VERSION_HEADER]: "v1",
						},
					}),
		);
		expect(
			await editor.media.relinkRecording({
				request: { projectItemId: "rec", path: "moved.mov" },
			}),
		).toMatchObject({
			kind: "confirmation-required",
			verification: "unverified",
		});
		expect(await editor.media.verifyRecordings()).toMatchObject([
			{ verification: "backfilled" },
		]);
		expect(save.mock.calls[0][0].projectItem.file).toMatchObject({
			contentHash: "a".repeat(64),
		});
		gone = true;
		expect(await editor.media.verifyRecordings()).toMatchObject([
			{ verification: "missing" },
		]);
		expect(editor.media.getProjectItems()[0].file).toMatchObject({
			contentHash: "a".repeat(64),
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

	test("graphic review dismissals survive a timeline move and lapse when the reason changes", async () => {
		const { editor, api, approval } = setUp();
		const { graphicId } = applyHighlight({ editor, api });
		expect(
			api.apply({
				sequenceId: editor.sequences.getActiveSequence().id,
				expectedRevision: api.getRevision(),
				label: "Replace picture",
				ops: [
					{
						op: "picture_repair",
						at: { seconds: 4 },
						duration: { seconds: 4 },
						projectItemId: "rec",
						sourceIn: 24,
					},
				],
			}),
		).toMatchObject({ ok: true });
		const listed = await approval.issuesList({});
		const issue =
			listed.ok && listed.issues.find(({ kind }) => kind === "graphic-flag");
		if (!issue) throw new Error("Expected the graphic review issue");
		expect(issue).toMatchObject({
			graphicId,
			start: 5,
			end: 5,
			detail: expect.stringContaining("covers the action"),
		});
		expect(
			await approval.dismissIssue({
				issueId: issue.id,
				evidence: issue.evidence,
			}),
		).toMatchObject({ ok: true });

		rippleDelete({ editor, api, start: 0, end: 1 });
		const { issues, unresolved } = reviewState({ editor });
		const moved = issues.find(({ id }) => id === issue.id);
		expect(moved).toMatchObject({
			start: 4,
			evidence: issue.evidence,
			dismissed: { by: "agent" },
		});
		expect(unresolved.some(({ id }) => id === issue.id)).toBe(false);

		rippleDelete({ editor, api, start: 3, end: 7 });
		const missing = reviewState({ editor }).unresolved.find(
			({ kind }) => kind === "graphic-flag",
		);
		expect(missing).toMatchObject({
			graphicId,
			start: 3,
			detail: expect.stringContaining("no longer in the cut"),
		});
		expect(missing?.evidence).not.toBe(issue.evidence);
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
