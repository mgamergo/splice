import { beforeEach, describe, expect, test } from "bun:test";
import { sequenceGraphicsSchema } from "@splice/bridge/graphics";
import { EditorApi } from "@/agent/editor-api";
import {
	deleteGraphic,
	findGraphicClip,
	graphicReviewIssues,
	planZoomView,
	summarizeGraphics,
} from "@/agent/graphics";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import { DeleteClipsCommand } from "@/commands/timeline/clip/delete-clips";
import { UpdateClipsCommand } from "@/commands/timeline/clip/update-clips";
import type { EditorCore } from "@/core";
import type { TimelineClip } from "@/timeline";
import { mediaTimeToSeconds } from "@/wasm";

let editor: EditorCore;
let api: EditorApi;

const sequence = () => editor.sequences.getActiveSequence();
const graphics = () => summarizeGraphics({ sequence: sequence() });
const byKey = (key: string) => {
	const found = graphics().find((graphic) => graphic.key === key);
	if (!found) throw new Error(`No graphic ${key}`);
	return found;
};
const clipOf = (key: string) => {
	const found = findGraphicClip({
		tracks: sequence().tracks,
		graphicId: byKey(key).id,
	});
	if (!found) throw new Error(`No clip for ${key}`);
	return found;
};
const startOf = (clip: TimelineClip) =>
	Number(mediaTimeToSeconds({ time: clip.startTime }).toFixed(3));

const zoom = {
	key: "zoom:settings",
	kind: "zoom" as const,
	projectItemId: "rec",
	passage: { start: 10, end: 14, text: "Open the settings" },
	action: 11,
	target: { x: 0.7, y: 0.1, width: 0.2, height: 0.1 },
};
const highlight = {
	key: "highlight:save",
	kind: "highlight" as const,
	projectItemId: "rec",
	passage: { start: 20, end: 23, text: "then press save" },
	action: 21,
	target: { x: 0.1, y: 0.8, width: 0.1, height: 0.05 },
};
const card = {
	key: "card:why",
	kind: "card" as const,
	projectItemId: "rec",
	passage: { start: 24, end: 28 },
	title: "Why save first",
	text: "Unsaved changes are lost when the session ends.",
};

function apply({
	planned,
	extra = {},
}: {
	planned: object[];
	extra?: object;
}) {
	return api.graphicsApply({
		sequenceId: sequence().id,
		expectedRevision: api.getRevision(),
		graphics: planned,
		...extra,
	});
}

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	editor.timeline.updateTracks({
		...sequence().tracks,
		main: {
			...sequence().tracks.main,
			clips: [videoClip({ id: "screen", start: 0, duration: 30 })],
		},
	});
	api = new EditorApi(editor);
});

describe("graphics pass", () => {
	test("applies zooms, highlights and cards as one undo step", () => {
		const result = apply({ planned: [zoom, highlight, card] });
		expect(result).toMatchObject({ ok: true, label: "Agent: graphics pass" });
		if (!result.ok) return;
		expect(result.graphics.map(({ status }) => status)).toEqual([
			"create",
			"create",
			"create",
		]);
		expect(byKey("zoom:settings")).toMatchObject({
			status: "shown",
			start: 10,
			end: 14,
			passage: { text: "Open the settings" },
			action: { projectItemId: "rec", time: 11 },
		});
		expect(clipOf("highlight:save").clip).toMatchObject({
			type: "graphic",
			definitionId: "highlight",
		});
		expect(clipOf("card:why").clip.params.content).toBe(
			"Why save first\nUnsaved changes are lost when the session\nends.",
		);

		// The zoom is keyframes on the picture clip, easing in and out.
		const screen = sequence().tracks.main.clips[0];
		expect(screen.zoomGraphicIds).toEqual([byKey("zoom:settings").id]);
		const scaleKeys = (
			screen.animations?.["transform.scaleX"] as { keys: { value: number }[] }
		).keys.map(({ value }) => Number(value.toFixed(2)));
		expect(scaleKeys[0]).toBe(1);
		expect(Math.max(...scaleKeys)).toBeGreaterThan(1.2);
		expect(scaleKeys.at(-1)).toBe(1);

		editor.command.undo();
		expect(sequence().graphics).toBeUndefined();
		expect(sequence().tracks.overlay).toEqual([]);
		expect(sequence().tracks.main.clips[0].animations).toBeUndefined();
		editor.command.redo();
		expect(graphics()).toHaveLength(3);
	});

	test("previews a pass without changing the sequence", () => {
		const revision = api.getRevision();
		const result = api.graphicsPlan({ graphics: [zoom, card] });
		expect(result).toMatchObject({ ok: true });
		expect(api.getRevision()).toBe(revision);
		expect(sequence().graphics).toBeUndefined();
	});

	test("leaves the shot wide when the target is uncertain or already legible", () => {
		const result = apply({ planned: [
			{ ...zoom, confidence: "low", target: undefined },
			{
				...zoom,
				key: "zoom:whole",
				action: 3,
				passage: { start: 2, end: 5 },
				target: { x: 0, y: 0, width: 1, height: 1 },
			},
		] });
		expect(result.ok && result.graphics.map(({ status }) => status)).toEqual([
			"skip_left_wide",
			"skip_left_wide",
		]);
		expect(graphics()).toEqual([]);
	});

	test("a rerun updates graphics in place and keeps the creator's adjustments", () => {
		apply({ planned: [highlight, card] });
		const { trackId, clip } = clipOf("highlight:save");
		// The creator nudges the highlight and retimes the card.
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
		const cardClip = clipOf("card:why");
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [
					{
						trackId: cardClip.trackId,
						clipId: cardClip.clip.id,
						patch: { startTime: s(25) },
					},
				],
			}),
		});
		expect(byKey("highlight:save").adjusted).toEqual(["position"]);
		expect(byKey("card:why").adjusted).toEqual(["start"]);

		const result = apply({ planned: [
			{ ...highlight, target: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } },
			// No key: matched by kind and action instead.
			{ ...card, key: undefined, text: "A new explanation." },
		] });
		expect(result.ok && result.graphics).toMatchObject([
			{ status: "update", keeps: ["position"] },
			{ status: "update", keeps: ["start"] },
		]);
		expect(graphics()).toHaveLength(2);
		expect(clipOf("highlight:save").clip.params["transform.positionX"]).toBe(123);
		expect(startOf(clipOf("card:why").clip)).toBe(25);
		expect(clipOf("card:why").clip.params.content).toBe(
			"Why save first\nA new explanation.",
		);
	});

	test("a deleted graphic stays deleted on later passes", () => {
		apply({ planned: [highlight, card] });
		const { trackId, clip } = clipOf("highlight:save");
		editor.command.execute({
			command: new DeleteClipsCommand({ clips: [{ trackId, clipId: clip.id }] }),
		});
		expect(graphics().map(({ key }) => key)).toEqual(["card:why"]);
		expect(sequence().graphics?.tombstones).toEqual([
			{ key: "highlight:save", kind: "highlight", projectItemId: "rec", action: 21 },
		]);

		const result = apply({ planned: [{ ...highlight, key: "another-name" }, card] });
		expect(result.ok && result.graphics.map(({ status }) => status)).toEqual([
			"skip_deleted",
			"update",
		]);
		expect(graphics()).toHaveLength(1);

		// Undoing the delete brings the graphic back with its record.
		editor.command.undo();
		editor.command.undo();
		expect(graphics().map(({ key }) => key)).toEqual(["highlight:save", "card:why"]);
	});

	test("graphics follow their action through cuts, keeping their offset", () => {
		apply({ planned: [zoom, highlight] });
		const { trackId, clip } = clipOf("highlight:save");
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [{ trackId, clipId: clip.id, patch: { startTime: s(21) } }],
			}),
		});
		expect(byKey("highlight:save").adjusted).toEqual(["start"]);

		// Cutting 2–5 s pulls everything after it 3 s earlier.
		api.apply({
			sequenceId: sequence().id,
			expectedRevision: api.getRevision(),
			label: "Cut",
			ops: [
				{
					op: "ripple_delete",
					ranges: [{ start: { seconds: 2 }, end: { seconds: 5 } }],
				},
			],
		});
		expect(byKey("zoom:settings")).toMatchObject({ start: 7, end: 11 });
		expect(startOf(clipOf("highlight:save").clip)).toBe(18);
		// A cut isn't the creator adjusting the graphic.
		expect(byKey("zoom:settings").adjusted).toEqual([]);
		// The zoom's keyframes moved with it onto the clip that now shows it.
		const shows = sequence().tracks.main.clips.find((candidate) =>
			candidate.zoomGraphicIds?.includes(byKey("zoom:settings").id),
		);
		expect(shows).toBeDefined();
	});

	test("flags a graphic whose action a cut removes, and brings it back on undo", () => {
		apply({ planned: [highlight] });
		api.apply({
			sequenceId: sequence().id,
			expectedRevision: api.getRevision(),
			label: "Swap the take",
			ops: [
				{
					op: "ripple_delete",
					ranges: [{ start: { seconds: 19 }, end: { seconds: 25 } }],
				},
			],
		});
		expect(byKey("highlight:save")).toMatchObject({
			status: "off",
			flags: [{ code: "action_missing" }],
		});
		expect(
			findGraphicClip({ tracks: sequence().tracks, graphicId: byKey("highlight:save").id }),
		).toBeNull();
		expect(graphicReviewIssues({ sequence: sequence() })).toMatchObject([
			{ kind: "highlight", code: "action_missing" },
		]);

		editor.command.undo();
		expect(byKey("highlight:save")).toMatchObject({ status: "shown", flags: [] });
	});

	test("flags a graphic whose narration was partly cut", () => {
		apply({ planned: [card] });
		api.apply({
			sequenceId: sequence().id,
			expectedRevision: api.getRevision(),
			label: "Tighten",
			ops: [
				{
					op: "ripple_delete",
					ranges: [{ start: { seconds: 26 }, end: { seconds: 28 } }],
				},
			],
		});
		expect(byKey("card:why").flags).toMatchObject([{ code: "passage_changed" }]);
	});

	test("hiding a zoom's handle turns the zoom off and is kept as an adjustment", () => {
		apply({ planned: [zoom] });
		const { trackId, clip } = clipOf("zoom:settings");
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [{ trackId, clipId: clip.id, patch: { hidden: true } }],
			}),
		});
		expect(byKey("zoom:settings")).toMatchObject({
			status: "hidden",
			adjusted: ["hidden"],
		});
		expect(sequence().tracks.main.clips[0].animations).toBeUndefined();
		editor.command.undo();
		expect(sequence().tracks.main.clips[0].zoomGraphicIds).toHaveLength(1);
	});

	test("prune removes earlier graphics the plan dropped, unless adjusted", () => {
		apply({ planned: [highlight, card] });
		const { trackId, clip } = clipOf("card:why");
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [{ trackId, clipId: clip.id, patch: { hidden: true } }],
			}),
		});
		const result = apply({ planned: [zoom], extra: { prune: true } });
		expect(result).toMatchObject({ ok: true, removed: 1 });
		expect(graphics().map(({ key }) => key).sort()).toEqual([
			"card:why",
			"zoom:settings",
		]);
	});

	test("a zoom stays off a picture clip that has the creator's own keyframes", () => {
		const screen = sequence().tracks.main.clips[0];
		editor.timeline.updateTracks({
			...sequence().tracks,
			main: {
				...sequence().tracks.main,
				clips: [
					{
						...screen,
						animations: {
							"transform.scaleX": {
								keys: [
									{
										id: "mine",
										time: s(0),
										value: 1.1,
										segmentToNext: "linear",
										tangentMode: "flat",
									},
								],
							},
						},
					},
				],
			},
		});
		apply({ planned: [zoom] });
		expect(byKey("zoom:settings").flags).toMatchObject([{ code: "zoom_conflict" }]);
		expect(sequence().tracks.main.clips[0].zoomGraphicIds).toBeUndefined();
	});

	test("deleting from the Graphics panel removes an off-sequence graphic for good", () => {
		apply({ planned: [highlight] });
		const next = deleteGraphic({
			sequence: sequence(),
			graphicId: byKey("highlight:save").id,
		});
		if (!next) throw new Error("expected a change");
		editor.command.execute({
			command: new UpdateSequenceCommand({
				editor,
				sequenceId: sequence().id,
				updates: next,
				label: "Delete graphic",
			}),
		});
		expect(graphics()).toEqual([]);
		expect(sequence().graphics?.tombstones).toHaveLength(1);
	});

	test("the saved graphics state validates against its schema", () => {
		apply({ planned: [zoom, highlight, card] });
		expect(sequenceGraphicsSchema.safeParse(sequence().graphics).success).toBe(
			true,
		);
	});

	test("lists graphics only for the active sequence", () => {
		expect(api.graphicsList({ sequenceId: "elsewhere" })).toMatchObject({
			ok: false,
			code: "INVALID_OP",
		});
	});
});

describe("planZoomView", () => {
	const canvas = { width: 1920, height: 1080 };
	const frame = { center: { x: 0, y: 0 }, width: 1920, height: 1080 };

	test("magnifies a small target and keeps the view inside the picture", () => {
		const view = planZoomView({
			frame,
			canvas,
			target: { center: { x: 900, y: -500 }, width: 200, height: 60 },
		});
		expect(view?.scale).toBe(2.5);
		// Half the view is 384 × 216 px; it can't center past the picture's edge.
		expect(view?.center).toEqual({ x: 960 - 384, y: -540 + 216 });
	});

	test("declines a target that is already legible", () => {
		expect(
			planZoomView({
				frame,
				canvas,
				target: { center: { x: 0, y: 0 }, width: 1500, height: 800 },
			}),
		).toBeNull();
	});
});
