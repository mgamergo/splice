import { isDiskMedia } from "@/media/media-data";
import type { ProjectItem } from "@/media/types";
import { type SequenceTracks, updateClipInSequenceTracks } from "@/timeline";
import { audibleClips } from "@/agent/loudness";

/**
 * Turns noise reduction on or off for the audible clips of disk items, the
 * only items `splice` can render noise-reduced audio for.
 */
export function setNoiseReduction({
	tracks,
	projectItems,
	enabled,
}: {
	tracks: SequenceTracks;
	projectItems: ProjectItem[];
	enabled: boolean;
}): SequenceTracks {
	const onDisk = new Set(
		projectItems.filter(({ file }) => isDiskMedia(file)).map(({ id }) => id),
	);
	let updated = tracks;
	for (const { trackId, clip } of audibleClips({ tracks, projectItems })) {
		if (!onDisk.has(clip.mediaId)) continue;
		updated = updateClipInSequenceTracks({
			tracks: updated,
			trackId,
			clipId: clip.id,
			update: (current) => ({
				...current,
				params: { ...current.params, noiseReduction: enabled },
			}),
		});
	}
	return updated;
}
