import { sequenceStyle } from "@/agent/style-profile";
import { layoutShort } from "@/agent/short-layout";
import { projectShortStyle } from "@/project/format";
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
	recordFraming,
}: {
	editor: EditorCore;
	recordFraming: boolean;
}): Command | null {
	const project = editor.project.getActiveOrNull();
	const sequence = editor.sequences.getActiveSequenceOrNull();
	if (!project || !sequence) return null;
	const shortStyle = projectShortStyle({ project });
	if (!sequence.graphics && !shortStyle) return null;
	const projectItems = editor.media.getProjectItems();
	const canvas = project.settings.canvasSize;
	const defaults = sequenceStyle({ project, sequence }).values;
	const synced = syncGraphics({
		sequence,
		projectItems,
		canvas,
		shortStyle,
		style: defaults,
		recordFraming,
	});
	const current = { ...sequence, ...synced };
	const tracks = shortStyle
		? layoutShort({
				sequence: current,
				style: shortStyle,
				projectItems,
				canvas,
				defaults,
			})
		: current.tracks;
	if (
		JSON.stringify(current.graphics) === JSON.stringify(sequence.graphics) &&
		(tracks === sequence.tracks ||
			JSON.stringify(tracks) === JSON.stringify(sequence.tracks))
	)
		return null;
	return new UpdateSequenceCommand({
		editor,
		sequenceId: sequence.id,
		updates: { ...synced, tracks },
		label: "Graphics and captions follow the edit",
		keepSelection: true,
	});
}
