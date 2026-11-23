import { beforeEach, describe, expect, test } from "bun:test";
import {
	type EditOp,
	editOpSchema,
	type RemovalMarkerData,
} from "@splice/bridge/ops";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import type { EditorCore } from "@/core";
import { normalizeMarkers } from "@/services/storage/service";
import { buildSeparatedAudioClip } from "@/timeline/audio-separation";
import { clampMarkerDragTime } from "@/timeline/markers/utils";
import { ToggleMarkerCommand } from "@/commands/sequence/toggle-marker";
import { MoveMarkerCommand } from "@/commands/sequence/move-marker";

const bestTake = {
	projectItemId: "rec",
	sourceIn: 4,
	sourceOut: 6,
	label: "Best",
};
const first = {
	projectItemId: "rec",
	sourceIn: 0,
	sourceOut: 3,
	label: "First",
};
const second = {
	projectItemId: "rec",
	sourceIn: 7,
	sourceOut: 8,
	transcriptSnippet: "Another intro",
};
const data: RemovalMarkerData = {
	kind: "removal",
	sectionName: "Intro",
	bestTake,
	badTakes: [first, second],
};
let editor: EditorCore;
let api: EditorApi;

function apply({ ops }: { ops: EditOp[] }) {
	return api.apply({
		sequenceId: editor.sequences.getActiveSequence().id,
		expectedRevision: api.getRevision(),
		label: "Edit takes",
		ops,
	});
}

const markers = () => editor.sequences.getActiveSequence().markers;
const spans = () =>
	editor.sequences
		.getActiveSequence()
		.tracks.main.clips.map((clip) => [
			clip.startTime,
			clip.duration,
			clip.trimStart,
		]);

function cutWithMarker() {
	const result = apply({
		ops: [
			{
				op: "ripple_delete",
				ranges: [
					{ start: { seconds: 0 }, end: { seconds: 3 } },
					{ start: { seconds: 7 }, end: { seconds: 8 } },
				],
			},
			{ op: "add_marker", at: { seconds: 1 }, data },
		],
	});
	expect(result).toMatchObject({ ok: true, revision: 1 });
	const id = markers()[0]?.id;
	if (!id) throw new Error("Missing removal marker ID");
	return id;
}

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	const { tracks } = editor.sequences.getActiveSequence();
	editor.timeline.updateTracks({
		...tracks,
		main: {
			...tracks.main,
			clips: [videoClip({ id: "original", start: 0, duration: 12 })],
		},
	});
	editor.media.setProjectItems({
		projectItems: [
			{
				id: "rec",
				name: "Recording",
				type: "video",
				duration: 12,
				hasAudio: true,
				file: new File([], "recording.mp4"),
			},
		],
	});
	api = new EditorApi(editor);
});

describe("removal markers", () => {
	test("validates source ranges and take indices at the bridge boundary", () => {
		const markerOp = { op: "add_marker", at: { seconds: 1 }, data };
		expect(editOpSchema.safeParse(markerOp).success).toBe(true);
		for (const badTakes of [
			[],
			[{ ...first, sourceOut: 0 }],
			[{ ...first, sourceIn: -1 }],
		]) {
			expect(
				editOpSchema.safeParse({ ...markerOp, data: { ...data, badTakes } })
					.success,
			).toBe(false);
		}
		expect(
			editOpSchema.safeParse({
				op: "swap_take",
				markerId: "mark",
				takeIndex: 0.5,
			}).success,
		).toBe(false);
		expect(
			editOpSchema.safeParse({
				op: "restore_takes",
				markerId: "mark",
				takeIndex: -1,
			}).success,
		).toBe(false);
	});

	test("round-trips metadata in format v1 and reports the marker ID in the digest", () => {
		const id = cutWithMarker();
		const saved = JSON.parse(JSON.stringify(markers()));
		expect(normalizeMarkers({ raw: saved })).toEqual([
			{ id, time: s(1), data },
		]);
		expect(
			normalizeMarkers({ raw: [s(2), { time: s(3), note: "Legacy" }] }),
		).toEqual([{ time: s(2) }, { time: s(3), note: "Legacy" }]);
		expect(api.getDigest()).toContain(
			`markers: 1.00 removal "Intro" (2 takes stored) [${id}]`,
		);
	});

	test("restores one or all stored ranges after another edit and clearing history", () => {
		const id = cutWithMarker();
		apply({ ops: [{ op: "razor", at: { seconds: 5 } }] });
		const before = spans();
		editor.command.clear();
		editor.command.isRippleEnabled = true;
		expect(
			apply({ ops: [{ op: "restore_takes", markerId: id, takeIndex: 0 }] }),
		).toMatchObject({ ok: true, revision: 3 });
		expect(spans()).toEqual([
			[s(0), s(1), s(3)],
			[s(1), s(3), s(0)],
			[s(4), s(3), s(4)],
			[s(7), s(1), s(8)],
			[s(8), s(3), s(9)],
		]);
		expect(markers()[0]?.data?.badTakes).toEqual([second]);
		editor.command.undo();
		expect(spans()).toEqual(before);
		expect(markers()[0]?.data?.badTakes).toEqual([first, second]);
		editor.command.redo();
		expect(api.getRevision()).toBe(5);
		expect(markers()[0]?.data?.badTakes).toEqual([second]);
		expect(
			apply({ ops: [{ op: "restore_takes", markerId: id }] }),
		).toMatchObject({ ok: true, revision: 6 });
		expect(markers()).toEqual([]);
		expect(spans()[1]).toEqual([s(1), s(1), s(7)]);
	});

	test("swaps the surviving best-take range and preserves neighboring source and later edits", () => {
		const id = cutWithMarker();
		apply({
			ops: [
				{
					op: "ripple_delete",
					ranges: [{ start: { seconds: 1.5 }, end: { seconds: 2 } }],
				},
				{ op: "add_marker", at: { seconds: 5 }, note: "Later" },
			],
		});
		const before = spans();
		expect(
			apply({ ops: [{ op: "swap_take", markerId: id, takeIndex: 0 }] }),
		).toMatchObject({ ok: true, revision: 3 });
		expect(spans()).toEqual([
			[s(0), s(1), s(3)],
			[s(1), s(3), s(0)],
			[s(4), s(1), s(6)],
			[s(5), s(4), s(8)],
		]);
		expect(markers()[0]?.data).toEqual({
			...data,
			bestTake: first,
			badTakes: [bestTake, second],
		});
		expect(markers()[1]).toEqual({ time: s(6.5), note: "Later" });
		const after = editor.sequences.getActiveSequence();
		editor.command.undo();
		expect(spans()).toEqual(before);
		editor.command.redo();
		expect(editor.sequences.getActiveSequence()).toEqual(after);
		expect(api.getRevision()).toBe(5);
	});

	test("swaps aligned extracted audio together with its video", () => {
		const sequence = editor.sequences.getActiveSequence();
		const clip = sequence.tracks.main.clips[0];
		if (clip.type !== "video") throw new Error("Expected a video clip");
		const audioClip = {
			...buildSeparatedAudioClip({ sourceClip: clip }),
			id: "extracted",
		};
		editor.timeline.updateTracks({
			...sequence.tracks,
			main: {
				...sequence.tracks.main,
				clips: [{ ...clip, isSourceAudioEnabled: false }],
			},
			audio: [
				{
					id: "audio-track",
					type: "audio",
					name: "A1",
					muted: false,
					clips: [audioClip],
				},
			],
		});
		const id = cutWithMarker();
		expect(
			apply({ ops: [{ op: "swap_take", markerId: id, takeIndex: 0 }] }),
		).toMatchObject({ ok: true });
		const { main, audio } = editor.sequences.getActiveSequence().tracks;
		expect(main.clips[1]).toMatchObject({ isSourceAudioEnabled: false });
		expect(
			audio[0].clips.map((item) => [
				item.startTime,
				item.duration,
				item.trimStart,
			]),
		).toEqual(spans());
		editor.command.undo();
		const restored = editor.sequences.getActiveSequence().tracks;
		const [track] = restored.audio;
		editor.timeline.updateTracks({
			...restored,
			audio: [
				{
					...track,
					clips: track.clips.map((item) => ({
						...item,
						startTime: s(0.1 + item.startTime / s(1)),
					})),
				},
			],
		});
		const before = editor.sequences.getActiveSequence();
		expect(
			apply({ ops: [{ op: "swap_take", markerId: id, takeIndex: 0 }] }),
		).toMatchObject({
			ok: false,
			code: "INVALID_OP",
			revision: 3,
		});
		expect(editor.sequences.getActiveSequence()).toBe(before);
	});

	test("retains a removal marker when a later ripple delete covers its time", () => {
		const id = cutWithMarker();
		expect(
			apply({
				ops: [
					{
						op: "ripple_delete",
						ranges: [{ start: { seconds: 0.5 }, end: { seconds: 1.5 } }],
					},
				],
			}),
		).toMatchObject({ ok: true, revision: 2 });
		expect(markers()).toEqual([{ id, time: s(0.5), data }]);
		expect(
			apply({ ops: [{ op: "restore_takes", markerId: id }] }),
		).toMatchObject({ ok: true, revision: 3 });
		expect(markers()).toEqual([]);
	});

	test("rejects Swap if only an unrelated copy of the original source survives", () => {
		const id = cutWithMarker();
		const { tracks } = editor.sequences.getActiveSequence();
		editor.timeline.updateTracks({
			...tracks,
			main: { ...tracks.main, clips: tracks.main.clips.slice(1) },
			overlay: [
				{
					id: "b-roll",
					type: "video",
					name: "B-roll",
					hidden: false,
					muted: false,
					clips: [
						videoClip({ id: "reuse", start: 10, duration: 2, trimStart: 4 }),
					],
				},
			],
		});
		const before = editor.sequences.getActiveSequence();
		expect(
			apply({ ops: [{ op: "swap_take", markerId: id, takeIndex: 0 }] }),
		).toMatchObject({
			ok: false,
			code: "INVALID_OP",
			revision: 1,
		});
		expect(editor.sequences.getActiveSequence()).toBe(before);
	});

	test("rejects a shorter Swap if the ripple would overlap another track", () => {
		const id = cutWithMarker();
		const { tracks } = editor.sequences.getActiveSequence();
		editor.timeline.updateTracks({
			...tracks,
			overlay: [
				{
					id: "overlay",
					type: "video",
					name: "Overlay",
					hidden: false,
					muted: false,
					clips: [
						videoClip({ id: "crosses", start: 2, duration: 1.5 }),
						videoClip({ id: "following", start: 4, duration: 1 }),
					],
				},
			],
		});
		const before = editor.sequences.getActiveSequence();
		expect(
			apply({ ops: [{ op: "swap_take", markerId: id, takeIndex: 1 }] }),
		).toMatchObject({
			ok: false,
			code: "INVALID_OP",
			revision: 1,
		});
		expect(editor.sequences.getActiveSequence()).toBe(before);
	});

	test("updates and deletes ordinary markers by stored time without touching removal data", async () => {
		const id = cutWithMarker();
		const toggle = () =>
			editor.command.execute({ command: new ToggleMarkerCommand(s(1)) });
		toggle();
		expect(markers()).toHaveLength(2);
		await editor.sequences.updateMarker({
			time: s(1),
			updates: { note: "Ordinary" },
		});
		expect(markers()).toEqual([
			{ id, time: s(1), data },
			{ time: s(1), note: "Ordinary" },
		]);
		toggle();
		expect(markers()).toEqual([{ id, time: s(1), data }]);
		toggle();
		const offFrame = s(0.99);
		editor.command.execute({
			command: new MoveMarkerCommand({ fromTime: s(1), toTime: offFrame }),
		});
		await editor.sequences.updateMarker({
			time: offFrame,
			updates: { note: "Off-frame" },
		});
		expect(markers()[0]).toEqual({ time: offFrame, note: "Off-frame" });
		await editor.sequences.removeMarker({ time: offFrame });
		expect(markers()).toEqual([{ id, time: s(1), data }]);
	});

	test("leaves the edit and revision intact when a stored source is unavailable", () => {
		const id = cutWithMarker();
		const before = editor.sequences.getActiveSequence();
		editor.media.setProjectItems({ projectItems: [] });
		expect(
			apply({ ops: [{ op: "restore_takes", markerId: id }] }),
		).toMatchObject({
			ok: false,
			code: "INVALID_OP",
			revision: 1,
		});
		expect(editor.sequences.getActiveSequence()).toBe(before);
	});

	test("clamps dragging to content end or the marker's own time on an empty timeline", () => {
		expect(
			clampMarkerDragTime({ time: s(4), duration: s(0), markerTime: s(2) }),
		).toBe(s(2));
		expect(
			clampMarkerDragTime({ time: s(1), duration: s(0), markerTime: s(2) }),
		).toBe(s(1));
		expect(
			clampMarkerDragTime({ time: s(8), duration: s(6), markerTime: s(2) }),
		).toBe(s(6));
	});
});
