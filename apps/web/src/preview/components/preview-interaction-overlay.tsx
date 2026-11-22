import { useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { usePreviewInteraction } from "@/preview/hooks/use-preview-interaction";
import type { SnapLine } from "@/preview/preview-snap";
import { TransformHandles } from "./transform-handles";
import { MaskHandles } from "./mask-handles";
import { SnapGuides } from "./snap-guides";
import { TextEditOverlay } from "./text-edit-overlay";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { useEditor } from "@/editor/use-editor";

export function PreviewInteractionOverlay() {
	const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
	const editor = useEditor();
	const viewport = usePreviewViewport();
	const selectedClips = useEditor((e) => e.selection.getSelectedClips());
	const activeTabPerType = usePropertiesStore((s) => s.activeTabPerType);

	const selectedRef =
		selectedClips.length === 1 ? selectedClips[0] : null;
	const activeTrack = selectedRef
		? editor.timeline.getTrackById({ trackId: selectedRef.trackId })
		: null;
	const activeElement =
		activeTrack?.clips.find(
			(clip) => clip.id === selectedRef?.clipId,
		) ?? null;
	const isMaskMode = activeElement
		? activeTabPerType[activeElement.type] === "masks"
		: false;

	const {
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onDoubleClick,
		editingText,
		commitTextEdit,
	} = usePreviewInteraction({
		onSnapLinesChange: setSnapLines,
		isMaskMode,
	});

	const handlePointerDown = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerDown({ event })) {
			return;
		}

		onPointerDown(event);
	};

	const handlePointerMove = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerMove({ event })) {
			return;
		}

		onPointerMove(event);
	};

	const handlePointerUp = (event: React.PointerEvent) => {
		if (viewport.handlePanPointerUp({ event })) {
			return;
		}

		onPointerUp(event);
	};

	return (
		<div className="absolute inset-0">
			<div
				className="absolute inset-0 pointer-events-auto"
				role="application"
				aria-label="Preview canvas"
				style={{
					cursor: viewport.isPanning
						? "grabbing"
						: viewport.canPan
							? "default"
							: undefined,
				}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onDoubleClick={onDoubleClick}
				onDragStart={(e) => e.preventDefault()}
			/>
			{editingText ? (
				<TextEditOverlay
					trackId={editingText.trackId}
					clipId={editingText.clipId}
					clip={editingText.clip}
					onCommit={commitTextEdit}
				/>
			) : isMaskMode ? (
				<MaskHandles onSnapLinesChange={setSnapLines} />
			) : (
				<TransformHandles onSnapLinesChange={setSnapLines} />
			)}
			<SnapGuides lines={snapLines} />
		</div>
	);
}
