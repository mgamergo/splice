import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { getMaskDefinition } from "@/masks";
import { appendPointToFreeformPathMask } from "@/masks/freeform/definition";
import {
	getVisibleClipsWithBounds,
	type ClipBounds,
} from "@/preview/clip-bounds";
import {
	SNAP_THRESHOLD_SCREEN_PIXELS,
	type SnapLine,
} from "@/preview/preview-snap";
import type { SelectedMaskPointSelection } from "@/selection/editor-selection";
import type { Mask, MaskHandleId, MaskInteractionResult } from "@/masks/types";
import type { MaskableClip } from "@/timeline";
import { isMaskableClip } from "@/timeline/clip-utils";
import { registerCanceller } from "@/editor/cancel-interaction";

interface DragState {
	trackId: string;
	clipId: string;
	handleId: MaskHandleId;
	startCanvasX: number;
	startCanvasY: number;
	startParams: Mask["params"];
}

interface PendingSegmentInsertState {
	trackId: string;
	clipId: string;
	maskId: string;
	segmentIndex: number;
	startClientX: number;
	startClientY: number;
	startCanvasX: number;
	startCanvasY: number;
	startParams: Mask["params"];
	bounds: ClipBounds;
}

const SEGMENT_CLICK_DRAG_THRESHOLD_PX = 4;

function isMaskSelectionForClip({
	trackId,
	clipId,
	maskId,
	selection,
}: {
	trackId: string;
	clipId: string;
	maskId: string;
	selection: SelectedMaskPointSelection | null;
}): boolean {
	if (!selection) {
		return false;
	}
	return (
		selection.trackId === trackId &&
		selection.clipId === clipId &&
		selection.maskId === maskId
	);
}

function replaceClipMask({
	masks,
	updatedMask,
}: {
	masks: MaskableClip["masks"];
	updatedMask: Mask;
}): Mask[] {
	return (masks ?? []).map((mask) =>
		mask.id === updatedMask.id ? updatedMask : mask,
	);
}

function withUpdatedMaskParams<TMask extends Mask>({
	mask,
	params,
}: {
	mask: TMask;
	params: TMask["params"];
}): TMask {
	return {
		...mask,
		params,
	};
}

export function useMaskHandles({
	onSnapLinesChange,
}: {
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const viewport = usePreviewViewport();
	const [activeHandleId, setActiveHandleId] = useState<MaskHandleId | null>(null);
	const dragStateRef = useRef<DragState | null>(null);
	const pendingSegmentInsertRef = useRef<PendingSegmentInsertState | null>(
		null,
	);
	const captureRef = useRef<{ clip: Element; pointerId: number } | null>(
		null,
	);

	const tracks = useEditor(
		(e) => e.timeline.getPreviewTracks() ?? e.sequences.getActiveSequence().tracks,
	);
	const currentTime = useEditor((e) => e.playback.getCurrentTime());
	const projectItems = useEditor((e) => e.media.getProjectItems());
	const canvasSize = useEditor(
		(e) => e.project.getActive().settings.canvasSize,
	);
	const selectedClips = useEditor((e) => e.selection.getSelectedClips());
	const selectedMaskPointSelection = useEditor((e) =>
		e.selection.getSelectedMaskPointSelection(),
	);

	const clipsWithBounds = getVisibleClipsWithBounds({
		tracks,
		currentTime,
		canvasSize,
		projectItems,
	});

	const selectedWithMask =
		selectedClips.length === 1
			? (() => {
					const sel = selectedClips[0];
					const entry = clipsWithBounds.find(
						(item) =>
							item.trackId === sel.trackId && item.clipId === sel.clipId,
					);
					if (!entry) return null;
					if (!isMaskableClip(entry.clip)) return null;
					const clip = entry.clip;
					const masks = clip.masks ?? [];
					if (masks.length === 0) return null;
					const activeMaskId = masks.some((mask) =>
						isMaskSelectionForClip({
							trackId: entry.trackId,
							clipId: entry.clipId,
							maskId: mask.id,
							selection: selectedMaskPointSelection,
						}),
					)
						? selectedMaskPointSelection?.maskId
						: masks[0].id;
					const mask =
						masks.find((candidate) => candidate.id === activeMaskId) ??
						masks[0];
					return { ...entry, clip, mask };
				})()
			: null;

	const { handles: baseHandlePositions, overlays }: MaskInteractionResult =
		selectedWithMask
			? (() => {
					const def = getMaskDefinition(selectedWithMask.mask.type);
					const { x: scaleX, y: scaleY } = viewport.getDisplayScale();
					const displayScale = (scaleX + scaleY) / 2;
					return def.interaction.getInteraction({
						params: selectedWithMask.mask.params,
						bounds: selectedWithMask.bounds,
						displayScale,
						scaleX,
						scaleY,
					});
				})()
			: { handles: [], overlays: [] };

	const selectedPointIds = new Set(
		selectedWithMask &&
			isMaskSelectionForClip({
				trackId: selectedWithMask.trackId,
				clipId: selectedWithMask.clipId,
				maskId: selectedWithMask.mask.id,
				selection: selectedMaskPointSelection,
			})
			? (selectedMaskPointSelection?.pointIds ?? [])
			: [],
	);

	const handlePositions = baseHandlePositions.map((handle) => {
		if (handle.id.kind !== "anchor") {
			return handle;
		}
		return {
			...handle,
			isSelected: selectedPointIds.has(handle.id.pointId),
		};
	});

	const customMaskPointIds = useMemo(
		() =>
			selectedWithMask?.mask.type === "freeform"
				? handlePositions
						.filter((h) => h.kind === "point")
						.map((h) => {
							return h.id.kind === "anchor" ? h.id.pointId : null;
						})
						.filter((id): id is string => id !== null)
				: [],
		[handlePositions, selectedWithMask?.mask.type],
	);
	const isCreatingFreeformPathMask =
		selectedWithMask?.mask.type === "freeform" &&
		(!selectedWithMask.mask.params.closed || customMaskPointIds.length === 0);

	useEffect(() => {
		if (!selectedMaskPointSelection) {
			return;
		}
		if (
			!selectedWithMask ||
			selectedWithMask.mask.type !== "freeform" ||
			!isMaskSelectionForClip({
				trackId: selectedWithMask.trackId,
				clipId: selectedWithMask.clipId,
				maskId: selectedWithMask.mask.id,
				selection: selectedMaskPointSelection,
			})
		) {
			editor.selection.clearMaskPointSelection();
			return;
		}

		const availablePointIds = new Set(customMaskPointIds);
		const nextSelectedPointIds = selectedMaskPointSelection.pointIds.filter(
			(pointId) => availablePointIds.has(pointId),
		);
		if (
			nextSelectedPointIds.length === selectedMaskPointSelection.pointIds.length
		) {
			return;
		}
		if (nextSelectedPointIds.length === 0) {
			editor.selection.clearMaskPointSelection();
			return;
		}

		editor.selection.setSelectedMaskPoints({
			selection: {
				...selectedMaskPointSelection,
				pointIds: nextSelectedPointIds,
			},
		});
	}, [
		customMaskPointIds,
		editor.selection,
		selectedMaskPointSelection,
		selectedWithMask,
	]);

	const updateFreeformPathMaskPointSelection = useCallback(
		({
			pointId,
			toggleSelection,
		}: {
			pointId: string;
			toggleSelection: boolean;
		}) => {
			if (!selectedWithMask || selectedWithMask.mask.type !== "freeform") {
				return;
			}

			const isSelectionForCurrentMask = isMaskSelectionForClip({
				trackId: selectedWithMask.trackId,
				clipId: selectedWithMask.clipId,
				maskId: selectedWithMask.mask.id,
				selection: selectedMaskPointSelection,
			});
			const currentPointIds = isSelectionForCurrentMask
				? (selectedMaskPointSelection?.pointIds ?? [])
				: [];
			const nextPointIds = toggleSelection
				? currentPointIds.includes(pointId)
					? currentPointIds.filter(
							(currentPointId) => currentPointId !== pointId,
						)
					: [...currentPointIds, pointId]
				: [pointId];

			if (nextPointIds.length === 0) {
				editor.selection.clearMaskPointSelection();
				return;
			}

			editor.selection.setSelectedMaskPoints({
				selection: {
					trackId: selectedWithMask.trackId,
					clipId: selectedWithMask.clipId,
					maskId: selectedWithMask.mask.id,
					pointIds: nextPointIds,
				},
			});
		},
		[editor.selection, selectedMaskPointSelection, selectedWithMask],
	);

	const clearMaskHandleState = useCallback(() => {
		dragStateRef.current = null;
		pendingSegmentInsertRef.current = null;
		setActiveHandleId(null);
		onSnapLinesChange?.([]);
	}, [onSnapLinesChange]);

	const releaseCapturedPointer = useCallback(() => {
		const capture = captureRef.current;
		if (!capture) return;

		if (capture.clip.hasPointerCapture(capture.pointerId)) {
			capture.clip.releasePointerCapture(capture.pointerId);
		}

		captureRef.current = null;
	}, []);

	useEffect(() => {
		if (!activeHandleId) return;

		return registerCanceller({
			fn: () => {
				editor.timeline.discardPreview();
				clearMaskHandleState();
				releaseCapturedPointer();
			},
		});
	}, [
		activeHandleId,
		clearMaskHandleState,
		editor.timeline,
		releaseCapturedPointer,
	]);

	const handlePointerDown = useCallback(
		({
			event,
			handleId,
		}: {
			event: React.PointerEvent;
			handleId: MaskHandleId;
		}) => {
			if (!selectedWithMask) return;
			if (event.button !== 0) return;
			event.stopPropagation();
			const anchorHandle =
				selectedWithMask.mask.type === "freeform" && handleId.kind === "anchor"
					? handleId
					: null;
			const segmentHandle =
				selectedWithMask.mask.type === "freeform" && handleId.kind === "segment"
					? handleId
					: null;
			if (isCreatingFreeformPathMask) {
				const firstPointId = customMaskPointIds[0];
				if (
					firstPointId &&
					handleId.kind === "anchor" &&
					handleId.pointId === firstPointId &&
					customMaskPointIds.length >= 3 &&
					selectedWithMask.mask.type === "freeform"
				) {
					const updatedMask = withUpdatedMaskParams({
						mask: selectedWithMask.mask,
						params: {
							...selectedWithMask.mask.params,
							closed: true,
						},
					});
					editor.timeline.updateClips({
						updates: [
							{
								trackId: selectedWithMask.trackId,
								clipId: selectedWithMask.clipId,
								patch: {
									masks: replaceClipMask({
										masks: selectedWithMask.clip.masks,
										updatedMask,
									}),
								} as Partial<MaskableClip>,
							},
						],
					});
				}
				return;
			}

			const pos = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!pos) return;

			if (segmentHandle && selectedWithMask.mask.type === "freeform") {
				setActiveHandleId(handleId);
				pendingSegmentInsertRef.current = {
					trackId: selectedWithMask.trackId,
					clipId: selectedWithMask.clipId,
					maskId: selectedWithMask.mask.id,
					segmentIndex: segmentHandle.index,
					startClientX: event.clientX,
					startClientY: event.clientY,
					startCanvasX: pos.x,
					startCanvasY: pos.y,
					startParams: { ...selectedWithMask.mask.params },
					bounds: selectedWithMask.bounds,
				};
				const captureTarget = event.currentTarget;
				captureTarget.setPointerCapture(event.pointerId);
				captureRef.current = {
					clip: captureTarget,
					pointerId: event.pointerId,
				};
				return;
			}

			if (anchorHandle) {
				updateFreeformPathMaskPointSelection({
					pointId: anchorHandle.pointId,
					toggleSelection: event.shiftKey,
				});
				if (event.shiftKey) {
					return;
				}
			} else if (selectedWithMask.mask.type === "freeform") {
				editor.selection.clearMaskPointSelection();
			}

			dragStateRef.current = {
				trackId: selectedWithMask.trackId,
				clipId: selectedWithMask.clipId,
				handleId,
				startCanvasX: pos.x,
				startCanvasY: pos.y,
				startParams: { ...selectedWithMask.mask.params },
			};
			setActiveHandleId(handleId);
			const captureTarget = event.currentTarget;
			captureTarget.setPointerCapture(event.pointerId);
			captureRef.current = {
				clip: captureTarget,
				pointerId: event.pointerId,
			};
		},
		[
			customMaskPointIds,
			editor.selection,
			editor.timeline,
			isCreatingFreeformPathMask,
			selectedWithMask,
			updateFreeformPathMaskPointSelection,
			viewport,
		],
	);

	const handleCanvasPointerDown = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			if (!selectedWithMask || !isCreatingFreeformPathMask) {
				return;
			}
			if (event.button !== 0) {
				return;
			}
			if (selectedWithMask.mask.type !== "freeform") {
				return;
			}

			event.stopPropagation();
			const pos = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!pos) {
				return;
			}

			const nextParams = appendPointToFreeformPathMask({
				params: selectedWithMask.mask.params,
				canvasPoint: pos,
				bounds: selectedWithMask.bounds,
			});
			const updatedMask = withUpdatedMaskParams({
				mask: selectedWithMask.mask,
				params: nextParams,
			});

			editor.timeline.updateClips({
				updates: [
					{
						trackId: selectedWithMask.trackId,
						clipId: selectedWithMask.clipId,
						patch: {
							masks: replaceClipMask({
								masks: selectedWithMask.clip.masks,
								updatedMask,
							}),
						} as Partial<MaskableClip>,
					},
				],
			});
		},
		[editor.timeline, isCreatingFreeformPathMask, selectedWithMask, viewport],
	);

	const handlePointerMove = useCallback(
		({ event }: { event: React.PointerEvent }) => {
			const pendingSegmentInsert = pendingSegmentInsertRef.current;
			if (pendingSegmentInsert && !dragStateRef.current) {
				const distance = Math.hypot(
					event.clientX - pendingSegmentInsert.startClientX,
					event.clientY - pendingSegmentInsert.startClientY,
				);
				if (distance >= SEGMENT_CLICK_DRAG_THRESHOLD_PX) {
					dragStateRef.current = {
						trackId: pendingSegmentInsert.trackId,
						clipId: pendingSegmentInsert.clipId,
						handleId: { kind: "position" },
						startCanvasX: pendingSegmentInsert.startCanvasX,
						startCanvasY: pendingSegmentInsert.startCanvasY,
						startParams: pendingSegmentInsert.startParams,
					};
					pendingSegmentInsertRef.current = null;
					setActiveHandleId({ kind: "position" });
				}
			}

			const drag = dragStateRef.current;
			if (!drag || !selectedWithMask) return;

			const pos = viewport.screenToCanvas({
				clientX: event.clientX,
				clientY: event.clientY,
			});
			if (!pos) return;

			const deltaX = pos.x - drag.startCanvasX;
			const deltaY = pos.y - drag.startCanvasY;
			const def = getMaskDefinition(selectedWithMask.mask.type);

			const rawParams = def.computeParamUpdate({
				handleId: drag.handleId,
				startParams: drag.startParams,
				deltaX,
				deltaY,
				startCanvasX: drag.startCanvasX,
				startCanvasY: drag.startCanvasY,
				bounds: selectedWithMask.bounds,
				canvasSize,
			});
			const proposedParams = { ...drag.startParams, ...rawParams };

			const snapThreshold = viewport.screenPixelsToLogicalThreshold({
				screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
			});
			const { params: nextParams, activeLines } = isShiftHeldRef.current
				? { params: proposedParams, activeLines: [] as SnapLine[] }
				: (def.interaction.snap?.({
						handleId: drag.handleId,
						startParams: drag.startParams,
						proposedParams,
						bounds: selectedWithMask.bounds,
						canvasSize,
						snapThreshold,
					}) ?? { params: proposedParams, activeLines: [] as SnapLine[] });

			onSnapLinesChange?.(activeLines);

			const updatedMask = withUpdatedMaskParams({
				mask: selectedWithMask.mask,
				params: nextParams as typeof selectedWithMask.mask.params,
			});
			editor.timeline.previewClips({
				updates: [
					{
						trackId: drag.trackId,
						clipId: drag.clipId,
						updates: {
							masks: replaceClipMask({
								masks: selectedWithMask.clip.masks,
								updatedMask,
							}),
						} as Partial<MaskableClip>,
					},
				],
			});
		},
		[
			selectedWithMask,
			canvasSize,
			editor,
			isShiftHeldRef,
			onSnapLinesChange,
			viewport,
		],
	);

	const handlePointerUp = useCallback(() => {
		const pendingSegmentInsert = pendingSegmentInsertRef.current;
		if (pendingSegmentInsert && !dragStateRef.current) {
			editor.timeline.insertFreeformPathMaskPoint({
				trackId: pendingSegmentInsert.trackId,
				clipId: pendingSegmentInsert.clipId,
				maskId: pendingSegmentInsert.maskId,
				segmentIndex: pendingSegmentInsert.segmentIndex,
				canvasPoint: {
					x: pendingSegmentInsert.startCanvasX,
					y: pendingSegmentInsert.startCanvasY,
				},
				bounds: pendingSegmentInsert.bounds,
			});
			clearMaskHandleState();
			releaseCapturedPointer();
			return;
		}

		if (dragStateRef.current) {
			editor.timeline.commitPreview();
			clearMaskHandleState();
		}
		releaseCapturedPointer();
	}, [clearMaskHandleState, editor, releaseCapturedPointer]);

	return {
		selectedWithMask,
		handlePositions,
		overlays,
		isCreatingFreeformPathMask,
		handleCanvasPointerDown,
		activeHandleId,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
	};
}
