import { beforeEach, expect, spyOn, test } from "bun:test";
import type { EditOp } from "@splice/bridge/ops";
import { EditorApi } from "@/agent/editor-api";
import { s, setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { ToggleSourceAudioSeparationCommand } from "@/commands/timeline/clip/toggle-source-audio-separation";
import type { EditorCore } from "@/core";
import type { RemovalMarker } from "@/timeline";
import { buildEmptyTrack } from "@/timeline/placement";
import { buildDefaultSequence } from "@/timeline/sequences";
import { normalizeMarkers, storageService } from "@/services/storage/service";

const first = "recording-1";
const second = "recording-2";
const badTake = {
	label: "Across files",
	transcriptSnippet: "We applied the...",
	ranges: [
		{ projectItemId: first, sourceIn: 8, sourceOut: 12 },
		{ projectItemId: second, sourceIn: 0, sourceOut: 2 },
	],
};
const bestTake = {
	projectItemId: second,
	sourceIn: 4,
	sourceOut: 8,
	transcriptSnippet: "We applied the filter.",
};
const section = {
	name: "Filter",
	takes: [badTake, bestTake],
	bestTakeIndex: 1,
};

let editor: EditorCore;
let api: EditorApi;

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	editor.media.setProjectItems({
		projectItems: [first, second].map((id) => ({
			id,
			name: id,
			type: "video",
			duration: 12,
			hasAudio: true,
			file: new File([], id),
		})),
	});
	api = new EditorApi(editor);
});

const active = () => editor.sequences.getActiveSequence();
const raw = () =>
	api.rawSequence({
		projectItemIds: [first, second],
		expectedRevision: api.getRevision(),
	});
const cut = () =>
	api.roughCut({ sections: [section], expectedRevision: api.getRevision() });
const apply = (op: EditOp) =>
	api.apply({
		sequenceId: active().id,
		expectedRevision: api.getRevision(),
		label: "Edit sequence",
		ops: [op],
	});

test("assembles Raw in the given order with embedded audio and preserves the existing sequence", () => {
	const main = active();
	const result = api.rawSequence({
		projectItemIds: [second, first],
		expectedRevision: 0,
	});
	expect(result).toMatchObject({ ok: true, revision: 1, durationSeconds: 24 });
	expect(editor.sequences.getSequences()[0]).toBe(main);
	expect(active().name).toBe("Raw");
	expect(
		active().tracks.main.clips.map((clip) => [
			clip.mediaId,
			clip.startTime,
			clip.duration,
			clip.type === "video" && clip.isSourceAudioEnabled,
		]),
	).toEqual([
		[second, s(0), s(12), true],
		[first, s(12), s(12), true],
	]);
	expect(raw()).toMatchObject({ ok: false, code: "INVALID_OP", revision: 1 });
});

test("validates the plan without switching, creating a sequence, or changing the undo stack", () => {
	raw();
	const original = editor.sequences.getSequences();
	const revision = api.getRevision();
	const attempts = [
		{ ...section, bestTakeIndex: 5, error: "outside the takes list" },
		{
			...section,
			takes: [badTake, { ...bestTake, sourceIn: 1 }],
			error: "overlaps",
		},
		{
			...section,
			takes: [badTake, { ...bestTake, sourceOut: 13 }],
			error: "outside the source",
		},
		{
			...section,
			takes: [{ ...badTake, ranges: [...badTake.ranges].reverse() }, bestTake],
			error: "contiguous",
		},
	];
	for (const { error, ...invalidSection } of attempts) {
		expect(
			api.roughCut({
				expectedRevision: revision,
				sections: [section, invalidSection],
			}),
		).toMatchObject({
			ok: false,
			revision,
			message: expect.stringContaining(error),
		});
		expect(editor.sequences.getSequences()).toBe(original);
		expect(active().name).toBe("Raw");
	}
	expect(
		api.roughCut({ expectedRevision: revision - 1, sections: [section] }),
	).toMatchObject({
		ok: false,
		code: "REVISION_CONFLICT",
		digest: expect.stringContaining('sequence "Raw"'),
	});
	editor.command.undo();
	expect(editor.command.canUndo()).toBe(false);
	expect(active().name).toBe("Main sequence");
});

test("maps a take across a razor and recording boundary, then undoes and redoes the whole cut", () => {
	raw();
	expect(apply({ op: "razor", at: { seconds: 9 } })).toMatchObject({
		ok: true,
	});
	const source = active();
	const snapshot = structuredClone(source);
	const revision = api.getRevision();
	const result = cut();
	expect(result).toMatchObject({
		ok: true,
		revision: revision + 1,
		label: "Agent: rough cut",
		durationSeconds: 18,
		sections: [{ sectionName: "Filter", removedSeconds: 6 }],
	});
	const rough = active();
	expect(rough.name).toBe("Rough Cut");
	expect(
		rough.tracks.main.clips.map((clip) => [
			clip.mediaId,
			clip.startTime,
			clip.duration,
			clip.trimStart,
		]),
	).toEqual([
		[first, s(0), s(8), s(0)],
		[second, s(8), s(10), s(2)],
	]);
	expect(
		editor.sequences.getSequences().find(({ id }) => id === source.id),
	).toEqual(snapshot);
	expect(editor.project.getActive().currentSequenceId).toBe(rough.id);
	const markerId = rough.markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");
	const marker: RemovalMarker = {
		id: markerId,
		time: s(8),
		data: {
			kind: "removal",
			sectionName: "Filter",
			bestTake,
			badTakes: [badTake],
		},
	};
	expect(rough.markers).toEqual([marker]);
	expect(normalizeMarkers({ raw: rough.markers })).toEqual([marker]);
	expect(api.getDigest()).toContain(
		`markers: 8.00 removal "Filter" (1 take stored) [${markerId}]`,
	);
	expect(api.getDigest()).toContain(`sequence "Rough Cut" (${rough.id})`);
	expect(api.takesList({})).toMatchObject({
		ok: true,
		sequenceId: rough.id,
		markers: [
			{
				id: markerId,
				time: 8,
				sectionName: "Filter",
				bestTake,
				badTakes: [badTake],
			},
		],
	});
	expect(api.takesList({ sequenceId: source.id })).toMatchObject({
		ok: true,
		markers: [],
	});
	editor.command.undo();
	expect(active()).toBe(source);
	expect(editor.project.getActive().currentSequenceId).toBe(source.id);
	expect(editor.sequences.getSequences()).not.toContain(rough);
	editor.command.redo();
	expect(active()).toBe(rough);
	expect(cut()).toMatchObject({ ok: true });
	expect(active().name).toBe("Rough Cut 2");
});

test("restores or swaps the whole cross-file take and supports swapping it back with linked audio", () => {
	raw();
	const { tracks } = active();
	for (const clip of tracks.main.clips) {
		editor.command.execute({
			command: new ToggleSourceAudioSeparationCommand({
				trackId: tracks.main.id,
				clipId: clip.id,
			}),
		});
	}
	expect(cut()).toMatchObject({ ok: true });
	const rough = active();
	const removed = rough.markers[0].id;
	if (!removed) throw new Error("No removal marker");
	expect(apply({ op: "restore_takes", markerId: removed })).toMatchObject({
		ok: true,
	});
	expect(active().markers).toEqual([]);
	expect(
		active().tracks.main.clips.map((clip) => [clip.mediaId, clip.duration]),
	).toEqual([
		[first, s(8)],
		[first, s(4)],
		[second, s(2)],
		[second, s(10)],
	]);
	editor.command.undo();
	expect(
		apply({ op: "swap_take", markerId: removed, takeIndex: 0 }),
	).toMatchObject({ ok: true });
	const replacement = active().tracks.main.clips.filter((clip) =>
		clip.bestTakeMarkerIds?.includes(removed),
	);
	expect(
		replacement.map((clip) => [clip.mediaId, clip.startTime, clip.duration]),
	).toEqual([
		[first, s(10), s(4)],
		[second, s(14), s(2)],
	]);
	for (const clip of replacement) {
		expect(clip).toMatchObject({ isSourceAudioEnabled: false });
		expect(
			active().tracks.audio.flatMap((track) => track.clips),
		).toContainEqual(
			expect.objectContaining({
				startTime: clip.startTime,
				duration: clip.duration,
				sourceAudioGroupId: clip.sourceAudioGroupId,
			}),
		);
	}
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake: badTake, badTakes: [bestTake] }],
	});
	expect(
		apply({ op: "swap_take", markerId: removed, takeIndex: 0 }),
	).toMatchObject({ ok: true });
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake, badTakes: [badTake] }],
	});
});

test("rejects a cut planned before the creator switches sequences", async () => {
	const previousId = active().id;
	raw();
	const revision = api.getRevision();
	await editor.sequences.switchToSequence({ sequenceId: previousId });
	expect(
		api.roughCut({ expectedRevision: revision, sections: [section] }),
	).toMatchObject({
		ok: false,
		code: "REVISION_CONFLICT",
	});
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [section],
			label: "Cut filter",
		}),
	).toMatchObject({
		ok: true,
		label: "Cut filter",
	});
});

test("swaps a take spanning a video recording and a separate audio recording", () => {
	const audioId = "audio-recording";
	editor.media.setProjectItems({
		projectItems: [
			...editor.media.getProjectItems(),
			{
				id: audioId,
				name: audioId,
				type: "audio",
				duration: 12,
				file: new File([], audioId),
			},
		],
	});
	expect(
		api.rawSequence({
			projectItemIds: [first, second, audioId],
			expectedRevision: api.getRevision(),
		}),
	).toMatchObject({ ok: true, durationSeconds: 36 });
	const mixed = {
		ranges: [
			{ projectItemId: second, sourceIn: 10, sourceOut: 12 },
			{ projectItemId: audioId, sourceIn: 0, sourceOut: 2 },
		],
	};
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [{ ...section, takes: [mixed, bestTake] }],
		}),
	).toMatchObject({ ok: true, durationSeconds: 32 });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");

	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(
		active().tracks.main.clips.find((clip) =>
			clip.bestTakeMarkerIds?.includes(markerId),
		),
	).toMatchObject({ mediaId: second, startTime: s(16), duration: s(2) });
	expect(
		active()
			.tracks.audio.flatMap((track) => track.clips)
			.find((clip) => clip.bestTakeMarkerIds?.includes(markerId)),
	).toMatchObject({ mediaId: audioId, startTime: s(18), duration: s(2) });
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake, badTakes: [mixed] }],
	});
});

test("swaps back when only one part of a cross-file take has extracted audio", () => {
	editor.media.setProjectItems({
		projectItems: editor.media
			.getProjectItems()
			.map((item) => (item.id === first ? { ...item, hasAudio: false } : item)),
	});
	raw();
	const track = active().tracks.main;
	editor.command.execute({
		command: new ToggleSourceAudioSeparationCommand({
			trackId: track.id,
			clipId: track.clips[1].id,
		}),
	});
	expect(cut()).toMatchObject({ ok: true });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(
		active().tracks.main.clips.filter((clip) =>
			clip.bestTakeMarkerIds?.includes(markerId),
		),
	).toMatchObject([
		{ mediaId: first, isSourceAudioEnabled: true },
		{ mediaId: second, isSourceAudioEnabled: false },
	]);
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(api.takesList({})).toMatchObject({
		markers: [{ bestTake, badTakes: [badTake] }],
	});
});

test("requires a source sequence ID when Raw is ambiguous", () => {
	raw();
	const source = active();
	editor.sequences.setSequences({
		sequences: [
			...editor.sequences.getSequences(),
			buildDefaultSequence({ name: "Raw", isMain: false }),
		],
	});
	expect(cut()).toMatchObject({
		ok: false,
		message: expect.stringContaining("More than one sequence"),
	});
	expect(
		api.roughCut({
			sequenceId: source.id,
			expectedRevision: api.getRevision(),
			sections: [section],
		}),
	).toMatchObject({ ok: true });
});

test("opening another project discards both undo and redo for prepared sequences", async () => {
	raw();
	expect(cut()).toMatchObject({ ok: true });
	editor.command.undo();
	expect(editor.command.canUndo()).toBe(true);
	expect(editor.command.canRedo()).toBe(true);

	const save = spyOn(storageService, "saveProject").mockResolvedValue(
		undefined,
	);
	try {
		await editor.project.createNewProject({ name: "Another project" });
		const sequences = editor.sequences.getSequences();
		expect(editor.command.canUndo()).toBe(false);
		expect(editor.command.canRedo()).toBe(false);
		editor.command.undo();
		editor.command.redo();
		expect(editor.sequences.getSequences()).toBe(sequences);
		expect(sequences.map(({ name }) => name)).toEqual(["Main sequence"]);
	} finally {
		save.mockRestore();
	}
});

test("undo and redo a Rough Cut edit on its own sequence after switching to Raw", async () => {
	raw();
	const source = active();
	const original = structuredClone(source);
	expect(cut()).toMatchObject({ ok: true });
	const roughId = active().id;
	const track = active().tracks.main;
	editor.command.execute({
		command: new ToggleSourceAudioSeparationCommand({
			trackId: track.id,
			clipId: track.clips[0].id,
		}),
	});
	expect(active().tracks.audio).toHaveLength(1);

	await editor.sequences.switchToSequence({ sequenceId: source.id });
	editor.command.undo();
	expect(active().id).toBe(roughId);
	expect(active().tracks.audio).toHaveLength(0);
	expect(
		editor.sequences.getSequences().find(({ id }) => id === source.id),
	).toEqual(original);

	await editor.sequences.switchToSequence({ sequenceId: source.id });
	editor.command.redo();
	expect(active().id).toBe(roughId);
	expect(active().tracks.audio).toHaveLength(1);
	expect(
		editor.sequences.getSequences().find(({ id }) => id === source.id),
	).toEqual(original);
});

test("keeps the Rough Cut active when a pending Raw save completes", async () => {
	raw();
	let releaseSave = () => {};
	const pending = new Promise<void>((resolve) => {
		releaseSave = resolve;
	});
	const save = spyOn(storageService, "saveProject")
		.mockResolvedValue(undefined)
		.mockImplementationOnce(() => pending);
	try {
		const savingRaw = editor.project.saveCurrentProject();
		expect(cut()).toMatchObject({ ok: true });
		const roughId = active().id;
		releaseSave();
		await savingRaw;
		expect(editor.project.getActive().currentSequenceId).toBe(roughId);
		await editor.project.saveCurrentProject();
		expect(save.mock.calls[1]?.[0].project).toMatchObject({
			currentSequenceId: roughId,
		});
	} finally {
		save.mockRestore();
	}
});

test("maps one source range across a razor where only the first clip has extracted audio", () => {
	raw();
	expect(apply({ op: "razor", at: { seconds: 6 } })).toMatchObject({
		ok: true,
	});
	const track = active().tracks.main;
	editor.command.execute({
		command: new ToggleSourceAudioSeparationCommand({
			trackId: track.id,
			clipId: track.clips[0].id,
		}),
	});
	const takes = [
		{ projectItemId: first, sourceIn: 0, sourceOut: 2 },
		{ projectItemId: first, sourceIn: 4, sourceOut: 8 },
	];
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [{ ...section, takes }],
		}),
	).toMatchObject({ ok: true, durationSeconds: 22 });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(active().tracks.audio[0].clips).toContainEqual(
		expect.objectContaining({
			mediaId: first,
			startTime: s(2),
			duration: s(2),
			trimStart: s(0),
		}),
	);
	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
});

test.each([true, false])(
	"keeps the original video tracks after swapping back (split replacement: %s)",
	(splitReplacement) => {
		const alternateIds = ["alternate-1", "alternate-2"];
		editor.media.setProjectItems({
			projectItems: [
				...editor.media.getProjectItems(),
				...alternateIds.map((id) => ({
					id,
					name: id,
					type: "video" as const,
					duration: 12,
					file: new File([], id),
				})),
			],
		});
		expect(
			api.rawSequence({
				projectItemIds: [first, second, ...alternateIds],
				expectedRevision: api.getRevision(),
			}),
		).toMatchObject({ ok: true });
		expect(apply({ op: "razor", at: { seconds: 14 } })).toMatchObject({
			ok: true,
		});
		const { tracks } = active();
		const secondHead = tracks.main.clips[1];
		const backdrop = videoClip({ id: "backdrop", start: 12, duration: 2 });
		editor.timeline.updateTracks({
			...tracks,
			main: {
				...tracks.main,
				clips: tracks.main.clips.flatMap((clip) =>
					clip.id !== secondHead.id
						? [clip]
						: splitReplacement
							? [backdrop]
							: [],
				),
			},
			overlay: [
				{
					...buildEmptyTrack({ id: "overlay", type: "video" }),
					clips: [secondHead],
				},
			],
		});
		const chosen = splitReplacement
			? {
					ranges: [
						{ projectItemId: alternateIds[0], sourceIn: 8, sourceOut: 12 },
						{ projectItemId: alternateIds[1], sourceIn: 0, sourceOut: 2 },
					],
				}
			: { projectItemId: alternateIds[0], sourceIn: 1, sourceOut: 7 };
		expect(
			api.roughCut({
				expectedRevision: api.getRevision(),
				sections: [{ ...section, takes: [chosen, badTake] }],
			}),
		).toMatchObject({ ok: true });
		const markerId = active().markers[0]?.id;
		if (!markerId) throw new Error("No removal marker");

		expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
			ok: true,
		});
		if (splitReplacement)
			expect(active().tracks.main.clips).toContainEqual(backdrop);
		expect(active().tracks.main.clips).toContainEqual(
			expect.objectContaining({
				mediaId: alternateIds[0],
				startTime: s(8),
				duration: s(splitReplacement ? 4 : 6),
			}),
		);
		expect(active().tracks.overlay[0].clips).toMatchObject(
			splitReplacement
				? [{ mediaId: alternateIds[1], startTime: s(12), duration: s(2) }]
				: [],
		);
		expect(
			normalizeMarkers({ raw: active().markers })[0].data?.badTakePlacements,
		).toEqual([[{ trackId: tracks.main.id }, { trackId: "overlay" }]]);

		expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
			ok: true,
		});
		if (splitReplacement)
			expect(active().tracks.main.clips).toContainEqual(backdrop);
		expect(active().tracks.overlay[0].clips).toMatchObject([
			{ mediaId: second, startTime: s(12), duration: s(2) },
		]);
	},
);

test("swapping back keeps each extracted audio part on its original track", () => {
	raw();
	expect(apply({ op: "razor", at: { seconds: 14 } })).toMatchObject({
		ok: true,
	});
	const main = active().tracks.main;
	for (const clip of main.clips.slice(0, 2)) {
		editor.command.execute({
			command: new ToggleSourceAudioSeparationCommand({
				trackId: main.id,
				clipId: clip.id,
			}),
		});
	}
	const { tracks } = active();
	const audio = tracks.audio[0];
	const otherAudio = {
		...buildEmptyTrack({ id: "muted-audio", type: "audio" }),
		muted: true,
	};
	editor.timeline.updateTracks({
		...tracks,
		audio: [
			{ ...audio, clips: audio.clips.filter((clip) => clip.startTime < s(12)) },
			{
				...otherAudio,
				clips: audio.clips.filter((clip) => clip.startTime === s(12)),
			},
		],
	});
	expect(
		api.roughCut({
			expectedRevision: api.getRevision(),
			sections: [{ ...section, takes: [bestTake, badTake] }],
		}),
	).toMatchObject({ ok: true });
	const markerId = active().markers[0]?.id;
	if (!markerId) throw new Error("No removal marker");

	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	expect(
		active().tracks.audio.find(({ id }) => id === otherAudio.id),
	).toMatchObject({ muted: true, clips: [] });
	expect(
		normalizeMarkers({ raw: active().markers })[0].data?.badTakePlacements,
	).toEqual([
		[
			{ trackId: main.id, audioTrackId: audio.id },
			{ trackId: main.id, audioTrackId: otherAudio.id },
		],
	]);

	expect(apply({ op: "swap_take", markerId, takeIndex: 0 })).toMatchObject({
		ok: true,
	});
	const restoredAudio = active().tracks.audio.find(
		({ id }) => id === otherAudio.id,
	);
	expect(restoredAudio).toMatchObject({
		muted: true,
		clips: [{ mediaId: second, startTime: s(12), duration: s(2) }],
	});
	const restoredVideo = active().tracks.main.clips.find(
		({ startTime }) => startTime === s(12),
	);
	expect(restoredVideo?.sourceAudioGroupId).toBe(
		restoredAudio?.clips[0].sourceAudioGroupId,
	);
});
