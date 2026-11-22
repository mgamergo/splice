import { useEffect, useReducer, useState, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import { useShiftKey } from "@/hooks/use-shift-key";
import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import { registerCanceller } from "@/editor/cancel-interaction";
import {
	ClipInteractionController,
	type ClipInteractionDeps,
	type ClipInteractionDepsRef,
} from "@/timeline/controllers/clip-interaction-controller";
import type { SnapPoint } from "@/timeline/snapping";

interface UseClipInteractionProps {
	zoomLevel: number;
	tracksContainerRef: RefObject<HTMLDivElement | null>;
	tracksScrollRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useClipInteraction({
	zoomLevel,
	tracksContainerRef,
	tracksScrollRef,
	headerRef,
	snappingEnabled,
	onSnapPointChange,
}: UseClipInteractionProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const selection = useClipSelection();

	const deps: ClipInteractionDeps = {
		viewport: {
			getZoomLevel: () => zoomLevel,
			getTracksScrollEl: () => tracksScrollRef.current,
			getTracksContainerEl: () => tracksContainerRef.current,
			getHeaderEl: () => headerRef?.current ?? null,
		},
		input: {
			isShiftHeld: () => isShiftHeldRef.current,
		},
		sequence: {
			getTracks: () => editor.sequences.getActiveSequence().tracks,
			getActiveFps: () => editor.project.getActive()?.settings.fps ?? null,
		},
		selection: {
			getSelected: () => selection.selectedClips,
			isSelected: selection.isClipSelected,
			select: selection.selectClip,
			handleClick: selection.handleClipClick,
			clearKeyframeSelection: () => editor.selection.clearKeyframeSelection(),
		},
		playback: {
			getCurrentTime: () => editor.playback.getCurrentTime(),
		},
		timeline: {
			moveClips: (args) => editor.timeline.moveClips(args),
		},
		snap: {
			isEnabled: () => snappingEnabled,
			onChange: onSnapPointChange,
		},
	};
	const depsRef = useCommittedRef(deps) as ClipInteractionDepsRef;
	const [controller] = useState(
		() => new ClipInteractionController({ depsRef }),
	);

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);

	useEffect(() => {
		if (!controller.isActive) return;
		return registerCanceller({ fn: () => controller.cancel() });
	}, [controller.isActive, controller]);

	useEffect(() => () => controller.destroy(), [controller]);

	return {
		dragView: controller.view,
		handleClipMouseDown: controller.onClipMouseDown,
		handleClipClick: controller.onClipClick,
	};
}
