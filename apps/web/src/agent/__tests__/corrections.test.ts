import { expect, test } from "bun:test";
import { correctionEventSchema } from "@splice/bridge/profile";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor } from "@/agent/__tests__/fixtures";
import { EditRemovalMarkerCommand } from "@/commands/sequence/edit-removal-marker";
import { RazorClipsCommand } from "@/commands/timeline/clip/razor-clips";

const range = ([sourceIn, sourceOut]: [number, number]) => ({
	projectItemId: "rec",
	sourceIn,
	sourceOut,
});
const recording = ([sourceIn, sourceOut]: [number, number]) => ({
	...range([sourceIn, sourceOut]),
	recording: "talk.wav",
});

function setup() {
	const editor = setUpEditor({ tracks: {} });
	editor.media.setProjectItems({
		projectItems: [
			{
				id: "rec",
				name: "talk.wav",
				type: "audio",
				duration: 20,
				hasAudio: true,
				file: new File([], "talk.wav"),
			},
		],
	});
	const api = new EditorApi(editor);
	expect(
		api.rawSequence({ projectItemIds: ["rec"], expectedRevision: 0 }),
	).toMatchObject({ ok: true });
	const events = () =>
		correctionEventSchema
			.array()
			.parse(editor.command.getUnsavedCorrections({ projectId: "project-1" }));
	const corrections = () =>
		events().filter((event) => !("correctionId" in event));
	const active = () => editor.sequences.getActiveSequence();
	return { editor, api, active, corrections, events };
}

test("creator Swap records the displaced source and preserves the original agent ranking across later swaps", () => {
	const { editor, api, active, corrections, events } = setup();
	const best = {
		...range([10, 15]),
		ranking: { completeness: 0.9, fluency: 0.8, pacing: 0.7 },
	};
	const chosen = range([2, 7]);
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [{ name: "Intro", takes: [chosen, best], bestTakeIndex: 1 }],
		}),
	).toMatchObject({ ok: true });
	const { id: sequenceId, markers, tracks } = active();
	const markerId = markers[0].id;
	if (!markerId) throw new Error("Expected a removal marker");
	const clip = tracks.audio[0].clips.find(
		({ startTime }) => startTime === s(2),
	);
	if (!clip) throw new Error("Expected the surviving best take");
	editor.timeline.updateClipTrim({
		clipId: clip.id,
		trimStart: s(11),
		trimEnd: s(0),
		duration: s(9),
	});
	expect(corrections()).toEqual([]);

	const swap = () =>
		editor.command.execute({
			command: new EditRemovalMarkerCommand({
				editor,
				edit: { op: "swap_take", markerId, takeIndex: 0 },
			}),
		});
	swap();
	expect(corrections()).toMatchObject([
		{
			kind: "swap_take",
			projectId: "project-1",
			sequenceId,
			revision: api.getRevision(),
			before: [recording([11, 15])],
			after: [recording([2, 7])],
			decision: {
				markerId,
				sectionName: "Intro",
				agentBestTake: best,
				selectedTakes: [chosen],
			},
		},
	]);
	swap();
	expect(corrections()[1]).toMatchObject({
		before: [recording([2, 7])],
		after: [recording([10, 15])],
		decision: { agentBestTake: best },
	});
	editor.command.undo();
	editor.command.redo();
	expect(corrections()).toHaveLength(2);
	const correctionId = corrections()[1].id;
	expect(events().slice(2)).toMatchObject([
		{ kind: "cancel", correctionId },
		{ kind: "reactivate", correctionId },
	]);
	expect(new Set(events().map(({ id }) => id)).size).toBe(4);
});

test("creator Restore captures only the restored ranges, and the same op in an agent batch is ignored", () => {
	const { editor, api, active, corrections } = setup();
	const first = range([1, 3]);
	const second = range([5, 7]);
	const best = range([10, 15]);
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [
				{ name: "Intro", takes: [first, second, best], bestTakeIndex: 2 },
			],
		}),
	).toMatchObject({ ok: true });
	const markerId = active().markers[0].id;
	if (!markerId) throw new Error("Expected a removal marker");
	expect(
		api.apply({
			sequenceId: active().id,
			expectedRevision: api.getRevision(),
			label: "Restore first take",
			ops: [{ op: "restore_takes", markerId, takeIndex: 0 }],
		}),
	).toMatchObject({ ok: true });
	expect(corrections()).toEqual([]);
	editor.command.execute({
		command: new EditRemovalMarkerCommand({
			editor,
			edit: { op: "restore_takes", markerId },
		}),
	});
	expect(corrections()).toMatchObject([
		{
			kind: "restore_takes",
			before: [],
			after: [recording([5, 7])],
			decision: { agentBestTake: best, selectedTakes: [second] },
		},
	]);
});

test.each([
	{ kind: "pause", plan: { pauses: [range([5, 8])] }, cutIn: 5.2, cutOut: 7.8 },
	{
		kind: "false_start",
		plan: { falseStarts: [range([5, 8])] },
		cutIn: 5,
		cutOut: 8,
	},
	{
		kind: "filler_word",
		plan: { fillerWords: [range([5, 8])] },
		cutIn: 5,
		cutOut: 8,
	},
])(
	"creator re-trims a $kind at its agent-made source edge",
	({ kind, plan, cutIn, cutOut }) => {
		const { editor, api, active, corrections } = setup();
		expect(
			api.roughCut({ expectedRevision: api.getRevision(), ...plan }),
		).toMatchObject({ ok: true });
		const [left, right] = active().tracks.audio[0].clips;
		editor.timeline.updateClipTrim({
			clipId: right.id,
			trimStart: s(cutOut - 0.3),
			trimEnd: s(0),
			startTime: s(cutIn - 0.3),
			duration: s(20 - cutOut + 0.3),
		});
		expect(corrections()).toMatchObject([
			{
				kind: "retrim",
				before: [recording([cutOut, 20])],
				after: [recording([cutOut - 0.3, 20])],
				decision: {
					kind,
					edge: "in",
					sourceIn: cutIn,
					sourceOut: cutOut,
					...(kind === "pause" && { pauseSeconds: 3 }),
				},
			},
		]);
		editor.timeline.updateClipTrim({
			clipId: left.id,
			trimStart: s(0.5),
			trimEnd: left.trimEnd,
			duration: s(cutIn - 0.5),
		});
		expect(corrections()).toHaveLength(1);
	},
);

test("a razor keeps provenance only on the existing cut edges", () => {
	const { editor, api, active, corrections } = setup();
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			falseStarts: [range([5, 8])],
		}),
	).toMatchObject({ ok: true });
	const track = active().tracks.audio[0];
	const [left] = track.clips;
	editor.command.execute({
		command: new RazorClipsCommand({
			clips: [{ trackId: track.id, clipId: left.id }],
			splitTime: s(2),
		}),
	});
	const [first, second] = active().tracks.audio[0].clips;
	expect(first.tighteningOut).toBeUndefined();
	expect(second.tighteningOut?.kind).toBe("false_start");
	expect(corrections()).toEqual([]);
});

test("a false-start edge keeps its provenance when it snaps into a pause", () => {
	const { editor, api, active, corrections } = setup();
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			pauses: [range([4, 6]), range([8, 10])],
			falseStarts: [range([5, 9])],
		}),
	).toMatchObject({ ok: true });
	const [left] = active().tracks.audio[0].clips;
	editor.timeline.updateClipTrim({
		clipId: left.id,
		trimStart: s(0),
		trimEnd: s(16),
		duration: s(4),
	});
	expect(corrections()).toMatchObject([
		{
			kind: "retrim",
			before: [recording([0, 4.2])],
			after: [recording([0, 4])],
			decision: {
				kind: "false_start",
				edge: "out",
				sourceIn: 4.2,
				sourceOut: 9.8,
			},
		},
	]);
});
