import { EditorCore } from "@/core";
import { DEFAULT_CANVAS_SIZE } from "@/canvas/sizes";
import { DEFAULT_FPS } from "@/fps/defaults";
import type { TProject } from "@/project/types";
import { PROJECT_FORMAT_VERSION } from "@/services/storage/format";
import type { AudioClip, SequenceTracks, VideoClip } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";
import { type MediaTime, mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@/wasm";

export const s = (seconds: number): MediaTime => mediaTimeFromSeconds({ seconds });

export function videoClip({
	id,
	start,
	duration,
	trimStart = 0,
}: {
	id: string;
	start: number;
	duration: number;
	trimStart?: number;
}): VideoClip {
	return {
		id,
		name: id,
		type: "video",
		mediaId: "rec",
		startTime: s(start),
		duration: s(duration),
		trimStart: s(trimStart),
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	};
}

export function audioClip({ id, start, duration }: { id: string; start: number; duration: number }): AudioClip {
	return {
		id,
		name: id,
		type: "audio",
		sourceType: "upload",
		mediaId: "music",
		startTime: s(start),
		duration: s(duration),
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {},
	} as AudioClip;
}

/** A fresh editor with one project whose main sequence holds `tracks`. */
export function setUpEditor({ tracks }: { tracks: Partial<SequenceTracks> }): EditorCore {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	const sequence = buildDefaultSequence({ name: "Main sequence", isMain: true });
	sequence.tracks = { ...sequence.tracks, ...tracks };
	const project: TProject = {
		metadata: {
			id: "project-1",
			name: "Test",
			duration: ZERO_MEDIA_TIME,
			createdAt: new Date(0),
			updatedAt: new Date(0),
		},
		sequences: [sequence],
		currentSequenceId: sequence.id,
		settings: {
			fps: DEFAULT_FPS,
			canvasSize: DEFAULT_CANVAS_SIZE,
			canvasSizeMode: "preset",
			lastCustomCanvasSize: null,
			originalCanvasSize: null,
			background: { type: "color", color: "#000000" },
		},
		version: PROJECT_FORMAT_VERSION,
	};
	editor.project.setActiveProject({ project });
	editor.sequences.initializeSequences({ sequences: [sequence], currentSequenceId: sequence.id });
	return editor;
}
