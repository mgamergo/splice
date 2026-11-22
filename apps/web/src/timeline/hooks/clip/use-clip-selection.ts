import { useCallback } from "react";
import { useEditor } from "@/editor/use-editor";
import type { ClipRef } from "@/timeline/types";

export function useClipSelection() {
	const editor = useEditor();
	const selectedClips = useEditor((e) => e.selection.getSelectedClips());

	const isClipSelected = useCallback(
		({ trackId, clipId }: ClipRef) =>
			selectedClips.some(
				(clip) =>
					clip.trackId === trackId && clip.clipId === clipId,
			),
		[selectedClips],
	);

	const selectClip = useCallback(
		({ trackId, clipId }: ClipRef) => {
			editor.selection.setSelectedClips({
				clips: [{ trackId, clipId }],
			});
		},
		[editor],
	);

	const addClipToSelection = useCallback(
		({ trackId, clipId }: ClipRef) => {
			const alreadySelected = selectedClips.some(
				(clip) =>
					clip.trackId === trackId && clip.clipId === clipId,
			);
			if (alreadySelected) return;

			editor.selection.setSelectedClips({
				clips: [...selectedClips, { trackId, clipId }],
			});
		},
		[selectedClips, editor],
	);

	const removeClipFromSelection = useCallback(
		({ trackId, clipId }: ClipRef) => {
			editor.selection.setSelectedClips({
				clips: selectedClips.filter(
					(clip) =>
						!(clip.trackId === trackId && clip.clipId === clipId),
				),
			});
		},
		[selectedClips, editor],
	);

	const toggleClipSelection = useCallback(
		({ trackId, clipId }: ClipRef) => {
			const alreadySelected = selectedClips.some(
				(clip) =>
					clip.trackId === trackId && clip.clipId === clipId,
			);

			if (alreadySelected) {
				removeClipFromSelection({ trackId, clipId });
			} else {
				addClipToSelection({ trackId, clipId });
			}
		},
		[selectedClips, addClipToSelection, removeClipFromSelection],
	);

	const clearClipSelection = useCallback(() => {
		editor.selection.clearSelection();
	}, [editor]);

	const setClipSelection = useCallback(
		({ clips }: { clips: ClipRef[] }) => {
			editor.selection.setSelectedClips({ clips });
		},
		[editor],
	);


	/**
	 * Merges clips into the current selection, deduplicating by identity.
	 * Used for additive box-select where the pre-drag selection is preserved.
	 */
	const mergeClipsIntoSelection = useCallback(
		({ clips }: { clips: ClipRef[] }) => {
			const merged = [
				...selectedClips.filter(
					(selectedClip) =>
						!clips.some(
							(clip) =>
								clip.trackId === selectedClip.trackId &&
								clip.clipId === selectedClip.clipId,
						),
				),
				...clips,
			];
			editor.selection.setSelectedClips({ clips: merged });
		},
		[selectedClips, editor],
	);


	/**
	 * Handles click interaction on an clip.
	 * - Regular click: select only this clip
	 * - Multi-key click (Ctrl/Cmd): toggle this clip in selection
	 */
	const handleClipClick = useCallback(
		({
			trackId,
			clipId,
			isMultiKey,
		}: ClipRef & { isMultiKey: boolean }) => {
			if (isMultiKey) {
				toggleClipSelection({ trackId, clipId });
			} else {
				selectClip({ trackId, clipId });
			}
		},
		[toggleClipSelection, selectClip],
	);

	return {
		selectedClips,
		isClipSelected,
		selectClip,
		setClipSelection,
		mergeClipsIntoSelection,
		addClipToSelection,
		removeClipFromSelection,
		toggleClipSelection,
		clearClipSelection,
		handleClipClick,
	};
}
