import { useEditor } from "@/editor/use-editor";
import { findTrackInSequenceTracks, type TimelineClip } from "@/timeline";

/**
 * Subscribes to render tracks and returns the live (preview-aware) version of
 * an clip alongside helpers for previewing and committing updates.
 *
 * Use this wherever property fields need to reflect in-progress preview state
 * (e.g. a slider being dragged) rather than the last committed value.
 */
export function useClipPreview<T extends TimelineClip>({
	trackId,
	clipId,
	fallback,
}: {
	trackId: string;
	clipId: string;
	fallback: T;
}) {
	const editor = useEditor();
	useEditor((e) => e.timeline.getPreviewTracks());

	const previewTracks = editor.timeline.getPreviewTracks();
	const renderClip =
		(findTrackInSequenceTracks({
			tracks: previewTracks ?? editor.sequences.getActiveSequence().tracks,
			trackId,
		})?.clips.find((clip) => clip.id === clipId) as T | undefined) ??
		fallback;

	const previewUpdates = (updates: Partial<TimelineClip>) =>
		editor.timeline.previewClips({
			updates: [{ trackId, clipId, updates }],
		});

	const commit = () => editor.timeline.commitPreview();

	return { renderClip, previewUpdates, commit };
}
