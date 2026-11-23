import type { EditorCore } from "@/core";
import { AddTrackCommand, BatchCommand, InsertClipCommand } from "@/commands";
import {
	buildSubtitleTextClip,
	createMeasurementContext,
} from "./build-subtitle-text-clip";
import type { SubtitleCue } from "./types";

export function insertCaptionChunksAsTextTrack({
	editor,
	captions,
}: {
	editor: EditorCore;
	captions: SubtitleCue[];
}): string | null {
	if (captions.length === 0) {
		return null;
	}

	const addTrackCommand = new AddTrackCommand({ type: "text", index: 0 });
	const trackId = addTrackCommand.getTrackId();
	const canvasSize = editor.project.getActive().settings.canvasSize;
	const ctx = createMeasurementContext();
	const insertCommands = captions.map(
		(caption, index) =>
			new InsertClipCommand({
				placement: { mode: "explicit", trackId },
				clip: buildSubtitleTextClip({
					index,
					caption,
					canvasSize,
					ctx,
				}),
			}),
	);
	editor.command.execute({
		command: new BatchCommand([addTrackCommand, ...insertCommands]),
	});

	return trackId;
}
