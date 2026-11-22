import { PasteCommand } from "@/commands/timeline";
import type { ClipboardHandler } from "../types";

export const ClipsClipboardHandler = {
	type: "clips",

	canCopy({ selectedClips }) {
		return selectedClips.length > 0;
	},

	copy({ editor, selectedClips }) {
		if (selectedClips.length === 0) {
			return null;
		}

		const results = editor.timeline.getClipsWithTracks({
			clips: selectedClips,
		});
		const items = results.map(({ track, clip }) => {
			const { id: _clipId, ...clipWithoutId } = clip;
			return {
				trackId: track.id,
				trackType: track.type,
				clip: clipWithoutId,
			};
		});

		if (items.length === 0) {
			return null;
		}

		return {
			type: "clips",
			items,
		};
	},

	paste({ entry, context }) {
		if (entry.items.length === 0) {
			return null;
		}

		return new PasteCommand({
			time: context.time,
			clipboardItems: entry.items,
		});
	},
} satisfies ClipboardHandler<"clips">;
