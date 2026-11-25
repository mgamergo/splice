import { expect, test } from "bun:test";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { EditorApi } from "@/agent/editor-api";
import { validateProtectedSections } from "@/agent/protected-sections";
import { RippleDeleteRangesCommand } from "@/commands/sequence/ripple-delete-ranges";
import type { ApplyRequest } from "@splice/bridge/ops";

const time = (seconds: number) => ({ seconds });
const range = ([start, end]: [number, number]) => ({
	start: time(start),
	end: time(end),
});

function fixture({ payoffStart = 4 }: { payoffStart?: number } = {}) {
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
					videoClip({
						id: "payoff",
						start: payoffStart,
						duration: 2,
						trimStart: 4,
					}),
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
		scope: range([2, 4]),
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
							right: { clipId: "overlay" },
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
		ops: [{ op: "ripple_delete", ranges: [range([2, 4])] }],
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

test("an existing gap is not new when ripple delete shifts both of its clips", () => {
	const { api, request } = fixture({ payoffStart: 6 });
	const edit: ApplyRequest = {
		...request,
		scope: range([0, 2]),
		ops: [{ op: "ripple_delete", ranges: [range([0, 2])] }],
	};
	expect(api.previewOps(edit)).toMatchObject({
		ok: true,
		impact: { outsideScopeUntouched: false, newGapsAndJumpCuts: [] },
	});
});

test("a picture repair changes the visible clip at both edges below a translucent overlay", () => {
	const { editor, api, sequence } = fixture();
	const source = sequence();
	const main = {
		...source.tracks.main,
		clips: [videoClip({ id: "v1", start: 0, duration: 6 })],
	};
	const overlay = source.tracks.overlay.map((track) => ({
		...track,
		type: "video" as const,
		muted: false,
		hidden: false,
		clips: [
			{
				...videoClip({ id: "overlay", start: 0, duration: 6 }),
				params: { opacity: 0.5 },
			},
		],
	}));
	editor.sequences.setSequences({
		sequences: [{ ...source, tracks: { ...source.tracks, main, overlay } }],
	});
	editor.media.setProjectItems({
		projectItems: [
			{
				id: "repair",
				name: "Replacement",
				type: "video",
				duration: 6,
				file: new File([], "repair.mp4"),
			},
		],
	});
	const mainPicture = { clipId: "v1" };
	const repair = { projectItemId: "repair", start: 2, end: 4 };
	expect(
		api.previewOps({
			sequenceId: source.id,
			expectedRevision: api.getRevision(),
			label: "Repair picture",
			ops: [
				{
					op: "picture_repair",
					at: time(2),
					duration: time(2),
					projectItemId: "repair",
					sourceIn: 1,
				},
			],
		}),
	).toMatchObject({
		ok: true,
		impact: {
			affectedRange: { start: 2, end: 4 },
			adjacentTransitions: {
				start: {
					before: { left: mainPicture, right: mainPicture },
					after: { left: mainPicture, right: repair, gapSeconds: 0 },
				},
				end: {
					before: { left: mainPicture, right: mainPicture },
					after: { left: repair, right: mainPicture, gapSeconds: 0 },
				},
			},
		},
	});
});

test.each([1, 1 + 0.4 / s(3)])(
	"razoring a clip at rate %d before an existing gap does not report a new gap",
	(rate) => {
		const { editor, api, sequence } = fixture();
		const before = sequence();
		const main = {
			...before.tracks.main,
			clips: [
				{
					...videoClip({ id: "first", start: 0, duration: 6 }),
					retime: { rate },
				},
				videoClip({ id: "second", start: 8, duration: 2, trimStart: 8 }),
			],
		};
		editor.sequences.setSequences({
			sequences: [{ ...before, tracks: { ...before.tracks, main } }],
		});
		expect(
			api.previewOps({
				sequenceId: before.id,
				expectedRevision: api.getRevision(),
				label: "Split clip",
				ops: [{ op: "razor", at: time(3), clipIds: ["first"] }],
			}),
		).toMatchObject({ ok: true, impact: { newGapsAndJumpCuts: [] } });
	},
);

test("scoped ops and markers share the frame grid", () => {
	const { api, request, sequence } = fixture();
	const edit: ApplyRequest = {
		...request,
		scope: range([2.01, 3.975]),
		ops: [
			{ op: "add_marker", at: time(2.01) },
			{ op: "add_marker", at: time(3.99) },
		],
	};
	const impact = {
		scope: { start: 2, end: 4 },
		outsideScopeUntouched: true,
	};
	expect(api.previewOps(edit)).toMatchObject({ ok: true, impact });
	expect(api.apply(edit)).toMatchObject({ ok: true, impact });
	expect(sequence().markers.map(({ time }) => time)).toEqual([s(2), s(4)]);
	expect(
		api.previewOps({
			...edit,
			expectedRevision: api.getRevision(),
			scope: range([2.02, 2.01]),
		}),
	).toMatchObject({ code: "INVALID_OP" });
});

test("staged preview and unscoped apply protect a tagged removal-marker section", () => {
	const { editor, api, sequence, request } = fixture();
	const before = sequence();
	const take = { projectItemId: "rec", sourceIn: 2, sourceOut: 4 };
	const tagged = {
		...before,
		markers: [
			{
				id: "takes",
				time: s(2),
				data: {
					kind: "removal" as const,
					sectionName: "Setup",
					bestTake: take,
					badTakes: [{ ...take, sourceIn: 6, sourceOut: 8 }],
				},
			},
		],
		tracks: {
			...before.tracks,
			main: {
				...before.tracks.main,
				clips: before.tracks.main.clips.map((clip) =>
					clip.id === "detail"
						? { ...clip, bestTakeMarkerIds: ["takes"] }
						: clip,
				),
			},
		},
	};
	editor.sequences.setSequences({ sequences: [tagged] });
	const { scope: _scope, ...unscoped } = request;
	const edit: ApplyRequest = {
		...unscoped,
		ops: [{ op: "ripple_delete", ranges: [range([2, 4])] }],
	};
	const error = {
		code: "INVALID_OP",
		message: expect.stringContaining("whole “Setup” section"),
	};
	expect(api.previewOps(edit)).toMatchObject(error);
	expect(api.apply(edit)).toMatchObject(error);
	expect(
		api.apply({ ...edit, scope: request.scope, allowOutsideScope: true }),
	).toMatchObject(error);
	expect(sequence()).toBe(tagged);
	expect(api.getRevision()).toBe(request.expectedRevision);
	expect(editor.command.canUndo()).toBe(false);
	expect(api.previewOps({ ...edit, restructure: true })).toMatchObject({
		ok: true,
	});
	expect(api.apply({ ...edit, restructure: true })).toMatchObject({ ok: true });
	editor.command.undo();
	expect(sequence()).toBe(tagged);

	editor.command.execute({
		command: new RippleDeleteRangesCommand([{ start: s(2), end: s(4) }]),
	});
	expect(sequence().tracks.main.clips.map(({ id }) => id)).toEqual([
		"setup",
		"payoff",
	]);
});

test("section validation rejects an inversion even when both tagged source spans survive", () => {
	const { sequence } = fixture();
	const source = sequence();
	const bestTake = (sourceIn: number) => ({
		projectItemId: "rec",
		sourceIn,
		sourceOut: sourceIn + 2,
	});
	const main = {
		...source.tracks.main,
		clips: source.tracks.main.clips.map((clip) => ({
			...clip,
			bestTakeMarkerIds: [clip.id],
		})),
	};
	const before = {
		...source,
		protectedSections: [
			{ id: "setup", sectionName: "Setup", bestTake: bestTake(0) },
			{ id: "payoff", sectionName: "Payoff", bestTake: bestTake(4) },
		],
		tracks: { ...source.tracks, main },
	};
	const after = {
		...before,
		tracks: {
			...before.tracks,
			main: {
				...main,
				clips: main.clips.map((clip) => ({
					...clip,
					startTime:
						clip.id === "setup"
							? s(4)
							: clip.id === "payoff"
								? s(0)
								: clip.startTime,
				})),
			},
		},
	};
	expect(() => validateProtectedSections({ before, after })).toThrow(
		"This edit puts “Payoff” before “Setup”",
	);
	expect(() =>
		validateProtectedSections({ before, after, restructure: true }),
	).not.toThrow();
});
