import { syncGraphics } from "@/agent/graphics";
import type { Command } from "@/commands/base-command";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import type { EditorCore } from "@/core";

/**
 * After any edit, places the active sequence's graphics again so they follow
 * their actions and record what the creator changed. Returns null when they
 * are already in place.
 */
export function graphicsFollowUp({
	editor,
}: {
	editor: EditorCore;
}): Command | null {
	const project = editor.project.getActiveOrNull();
	const sequence = editor.sequences.getActiveSequenceOrNull();
	if (!project || !sequence?.graphics) return null;
	const synced = syncGraphics({
		sequence,
		projectItems: editor.media.getProjectItems(),
		canvas: project.settings.canvasSize,
	});
	if (
		!synced ||
		(JSON.stringify(synced.graphics) === JSON.stringify(sequence.graphics) &&
			JSON.stringify(synced.tracks) === JSON.stringify(sequence.tracks))
	)
		return null;
	return new UpdateSequenceCommand({
		editor,
		sequenceId: sequence.id,
		updates: synced,
		label: "Graphics follow the edit",
		keepSelection: true,
	});
}
