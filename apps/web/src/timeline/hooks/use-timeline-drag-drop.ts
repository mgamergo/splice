import { useEffect, useReducer, useState, type RefObject } from "react";
import { useEditor } from "@/editor/use-editor";
import { useCommittedRef } from "@/hooks/use-committed-ref";
import {
	DragDropController,
	type DragDropConfig,
} from "@/timeline/controllers/drag-drop-controller";

interface UseTimelineDragDropProps {
	containerRef: RefObject<HTMLDivElement | null>;
	headerRef?: RefObject<HTMLElement | null>;
	tracksScrollRef?: RefObject<HTMLDivElement | null>;
	zoomLevel: number;
}

export function useTimelineDragDrop({
	containerRef,
	headerRef,
	tracksScrollRef,
	zoomLevel,
}: UseTimelineDragDropProps) {
	const editor = useEditor();

	const config: DragDropConfig = {
		zoomLevel,
		getContainerEl: () => containerRef.current,
		getHeaderEl: () => headerRef?.current ?? null,
		getTracksScrollEl: () => tracksScrollRef?.current ?? null,
		getActiveProjectFps: () => editor.project.getActive()?.settings.fps ?? null,
		getActiveProjectId: () =>
			editor.project.getActiveOrNull()?.metadata.id ?? null,
		getSequenceTracks: () => editor.sequences.getActiveSequence().tracks,
		getCurrentPlayheadTime: () => editor.playback.getCurrentTime(),
		getProjectItems: () => editor.media.getProjectItems(),
		dragSource: editor.timeline.dragSource,
		addProjectItem: (args) => editor.media.addProjectItem(args),
		executeCommand: (command) => editor.command.execute({ command }),
		insertClip: (args) => editor.timeline.insertClip(args),
		addClipEffect: (args) => editor.timeline.addClipEffect(args),
	};
	const configRef = useCommittedRef(config);
	const [controller] = useState(() => new DragDropController({ configRef }));

	const [, rerender] = useReducer((n: number) => n + 1, 0);
	useEffect(() => controller.subscribe(rerender), [controller]);
	useEffect(() => () => controller.destroy(), [controller]);

	return {
		isDragOver: controller.isDragOver,
		dropTarget: controller.dropTarget,
		dragClipType: controller.dragClipType,
		dragProps: {
			onDragEnter: controller.onDragEnter,
			onDragOver: controller.onDragOver,
			onDragLeave: controller.onDragLeave,
			onDrop: controller.onDrop,
		},
	};
}
