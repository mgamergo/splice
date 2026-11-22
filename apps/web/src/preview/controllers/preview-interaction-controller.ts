import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import type { ProjectItem } from "@/media/types";
import {
	getVisibleClipsWithBounds,
	type ClipWithBounds,
} from "@/preview/clip-bounds";
import {
	getHitClips,
	hitTest,
	resolvePreferredHit,
} from "@/preview/hit-test";
import {
	SNAP_THRESHOLD_SCREEN_PIXELS,
	snapPosition,
	type SnapLine,
} from "@/preview/preview-snap";
import type { TCanvasSize } from "@/project/types";
import type { ParamValues } from "@/params";
import { buildTransformFromParams, type Transform } from "@/rendering";
import { isVisualClip } from "@/timeline/clip-utils";
import type {
	ClipRef,
	SequenceTracks,
	TextClip,
	TimelineClip,
	TimelineTrack,
	VisualClip,
} from "@/timeline";

const MIN_DRAG_DISTANCE = 0.5;
const PRIMARY_POINTER_BUTTON = 0;

type Point = { readonly x: number; readonly y: number };

interface CapturedPointerState {
	readonly pointerId: number;
	readonly captureTarget: HTMLElement;
}

interface PendingGesture extends CapturedPointerState {
	readonly kind: "pending";
	readonly origin: Point;
	readonly topmostHit: ClipWithBounds | null;
	readonly selectedHit: ClipWithBounds | null;
	readonly selectedClips: readonly ClipRef[];
}

interface DragClipSnapshot {
	readonly trackId: string;
	readonly clipId: string;
	readonly initialTransform: Transform;
	readonly initialParams: ParamValues;
}

interface DraggingGesture extends CapturedPointerState {
	readonly kind: "dragging";
	readonly origin: Point;
	readonly bounds: {
		readonly width: number;
		readonly height: number;
		readonly rotation: number;
	};
	readonly clips: readonly DragClipSnapshot[];
}

type GestureSession =
	| { readonly kind: "idle" }
	| PendingGesture
	| DraggingGesture;

const IDLE_GESTURE: GestureSession = { kind: "idle" };

export interface EditingTextState {
	readonly trackId: string;
	readonly clipId: string;
	readonly clip: TextClip;
}

export interface PreviewViewportAdapter {
	screenToCanvas: ({
		clientX,
		clientY,
	}: {
		clientX: number;
		clientY: number;
	}) => Point | null;
	screenPixelsToLogicalThreshold: ({
		screenPixels,
	}: {
		screenPixels: number;
	}) => Point;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SequenceReader {
	getTracks: () => SequenceTracks;
	getCurrentTime: () => number;
	getProjectItems: () => ProjectItem[];
	getCanvasSize: () => TCanvasSize;
}

export interface SelectionApi {
	getSelected: () => readonly ClipRef[];
	setSelected: (clips: readonly ClipRef[]) => void;
	clearSelection: () => void;
}

export interface TimelinePreviewUpdate {
	readonly trackId: string;
	readonly clipId: string;
	readonly updates: Partial<TimelineClip>;
}

export interface TimelineOps {
	getClipsWithTracks: ({
		clips,
	}: {
		clips: readonly ClipRef[];
	}) => Array<{ track: TimelineTrack; clip: TimelineClip }>;
	previewClips: (updates: readonly TimelinePreviewUpdate[]) => void;
	commitPreview: () => void;
	discardPreview: () => void;
}

export interface PlaybackApi {
	getIsPlaying: () => boolean;
	subscribe: (listener: () => void) => () => void;
}

export interface PreviewOptions {
	isMaskMode: () => boolean;
	onSnapLinesChange?: (lines: SnapLine[]) => void;
}

export interface PreviewInteractionDeps {
	viewport: PreviewViewportAdapter;
	input: InputAdapter;
	sequence: SequenceReader;
	selection: SelectionApi;
	timeline: TimelineOps;
	playback: PlaybackApi;
	preview: PreviewOptions;
}

export interface PreviewInteractionDepsRef {
	readonly current: PreviewInteractionDeps;
}

function isSameClipRef({
	left,
	right,
}: {
	left: ClipRef;
	right: ClipRef;
}): boolean {
	return left.trackId === right.trackId && left.clipId === right.clipId;
}

function buildDragSelection({
	selectedClips,
	dragTarget,
}: {
	selectedClips: readonly ClipRef[];
	dragTarget: ClipWithBounds;
}): ClipRef[] {
	const dragTargetRef = {
		trackId: dragTarget.trackId,
		clipId: dragTarget.clipId,
	};

	if (
		!selectedClips.some((selectedClip) =>
			isSameClipRef({ left: selectedClip, right: dragTargetRef }),
		)
	) {
		return [dragTargetRef];
	}

	return [
		dragTargetRef,
		...selectedClips.filter(
			(selectedClip) =>
				!isSameClipRef({ left: selectedClip, right: dragTargetRef }),
		),
	];
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > MIN_DRAG_DISTANCE ||
		Math.abs(current.y - origin.y) > MIN_DRAG_DISTANCE
	);
}

function toDragClipSnapshots({
	clipsWithTracks,
}: {
	clipsWithTracks: Array<{ track: TimelineTrack; clip: TimelineClip }>;
}): DragClipSnapshot[] {
	const isVisualTrackedClip = (value: {
		track: TimelineTrack;
		clip: TimelineClip;
	}): value is { track: TimelineTrack; clip: VisualClip } =>
		isVisualClip(value.clip);

	return clipsWithTracks
		.filter(isVisualTrackedClip)
		.map(({ track, clip }) => ({
			trackId: track.id,
			clipId: clip.id,
			initialTransform: buildTransformFromParams({ params: clip.params }),
			initialParams: clip.params,
		}));
}

export class PreviewInteractionController {
	private readonly depsRef: PreviewInteractionDepsRef;
	private readonly subscribers = new Set<() => void>();

	private gesture: GestureSession = IDLE_GESTURE;
	private editingTextState: EditingTextState | null = null;
	private wasPlaying: boolean;
	private unsubscribePlayback: (() => void) | null = null;

	constructor({ depsRef }: { depsRef: PreviewInteractionDepsRef }) {
		this.depsRef = depsRef;
		this.wasPlaying = this.deps.playback.getIsPlaying();

		this.onDoubleClick = this.onDoubleClick.bind(this);
		this.onPointerDown = this.onPointerDown.bind(this);
		this.onPointerMove = this.onPointerMove.bind(this);
		this.onPointerUp = this.onPointerUp.bind(this);
		this.commitTextEdit = this.commitTextEdit.bind(this);
		this.handlePlaybackChange = this.handlePlaybackChange.bind(this);

		this.unsubscribePlayback = this.deps.playback.subscribe(
			this.handlePlaybackChange,
		);
	}

	private get deps(): PreviewInteractionDeps {
		return this.depsRef.current;
	}

	get isDragging(): boolean {
		return this.gesture.kind === "dragging";
	}

	get editingText(): EditingTextState | null {
		return this.editingTextState;
	}

	subscribe({ listener }: { listener: () => void }): () => void {
		this.subscribers.add(listener);
		return () => this.subscribers.delete(listener);
	}

	destroy(): void {
		this.unsubscribePlayback?.();
		this.unsubscribePlayback = null;
		this.abortActiveGesture();
		this.editingTextState = null;
		this.subscribers.clear();
	}

	cancel(): void {
		if (this.gesture.kind === "idle") return;
		this.abortActiveGesture();
		this.notify();
	}

	private abortActiveGesture(): void {
		if (this.gesture.kind === "idle") return;

		if (this.gesture.kind === "dragging") {
			this.deps.timeline.discardPreview();
		}

		this.releaseCapturedPointer({ pointerState: this.gesture });
		this.gesture = IDLE_GESTURE;
		this.clearSnapLines();
	}

	commitTextEdit(): void {
		if (!this.editingTextState) return;

		this.editingTextState = null;
		this.deps.timeline.commitPreview();
		this.notify();
	}

	onDoubleClick({ clientX, clientY }: ReactMouseEvent): void {
		if (this.editingTextState || this.deps.preview.isMaskMode()) return;

		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hit = hitTest({
			canvasX: startPos.x,
			canvasY: startPos.y,
			clipsWithBounds: this.getVisibleClipsWithBounds(),
		});

		if (!hit || hit.clip.type !== "text") return;

		this.editingTextState = {
			trackId: hit.trackId,
			clipId: hit.clipId,
			clip: hit.clip,
		};
		this.notify();
	}

	onPointerDown({
		clientX,
		clientY,
		currentTarget,
		pointerId,
		button,
	}: ReactPointerEvent): void {
		if (this.editingTextState) return;
		if (this.deps.preview.isMaskMode()) return;
		if (button !== PRIMARY_POINTER_BUTTON) return;

		const startPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!startPos) return;

		const hits = getHitClips({
			canvasX: startPos.x,
			canvasY: startPos.y,
			clipsWithBounds: this.getVisibleClipsWithBounds(),
		});
		const selectedClips = this.deps.selection.getSelected();

		this.gesture = {
			kind: "pending",
			origin: startPos,
			pointerId,
			captureTarget: currentTarget as HTMLElement,
			topmostHit: hits[0] ?? null,
			selectedHit: resolvePreferredHit({
				hits,
				preferredClips: [...selectedClips],
			}),
			selectedClips,
		};

		currentTarget.setPointerCapture(pointerId);
	}

	onPointerMove({ clientX, clientY }: ReactPointerEvent): void {
		const currentPos = this.deps.viewport.screenToCanvas({
			clientX,
			clientY,
		});
		if (!currentPos) return;

		if (this.gesture.kind === "pending") {
			const pending = this.gesture;
			if (
				!movedPastDragThreshold({
					current: currentPos,
					origin: pending.origin,
				})
			) {
				this.clearSnapLines();
				return;
			}

			this.beginDragFromPending({ pending });
		}

		if (this.gesture.kind !== "dragging") return;

		this.updateDragPreview({
			drag: this.gesture,
			currentPos,
		});
	}

	onPointerUp({ type }: ReactPointerEvent): void {
		if (this.gesture.kind === "dragging") {
			const drag = this.gesture;

			if (type === "pointercancel") {
				this.deps.timeline.discardPreview();
			} else {
				this.deps.timeline.commitPreview();
			}

			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: drag });
			this.notify();
			return;
		}

		if (this.gesture.kind !== "pending") return;

		const pending = this.gesture;

		if (type !== "pointercancel") {
			const clickTarget = pending.topmostHit;
			if (!clickTarget) {
				this.deps.selection.clearSelection();
			} else {
				this.deps.selection.setSelected([
					{
						trackId: clickTarget.trackId,
						clipId: clickTarget.clipId,
					},
				]);
			}
		}

		this.gesture = IDLE_GESTURE;
		this.clearSnapLines();
		this.releaseCapturedPointer({ pointerState: pending });
	}

	private notify(): void {
		for (const listener of this.subscribers) listener();
	}

	private clearSnapLines(): void {
		this.deps.preview.onSnapLinesChange?.([]);
	}

	private releaseCapturedPointer({
		pointerState,
	}: {
		pointerState: CapturedPointerState | null;
	}): void {
		if (!pointerState) return;

		if (!pointerState.captureTarget.hasPointerCapture(pointerState.pointerId)) {
			return;
		}

		pointerState.captureTarget.releasePointerCapture(pointerState.pointerId);
	}

	private getVisibleClipsWithBounds(): ClipWithBounds[] {
		return getVisibleClipsWithBounds({
			tracks: this.deps.sequence.getTracks(),
			currentTime: this.deps.sequence.getCurrentTime(),
			canvasSize: this.deps.sequence.getCanvasSize(),
			projectItems: this.deps.sequence.getProjectItems(),
		});
	}

	private handlePlaybackChange(): void {
		const isPlaying = this.deps.playback.getIsPlaying();
		if (isPlaying && !this.wasPlaying && this.editingTextState) {
			this.commitTextEdit();
		}
		this.wasPlaying = isPlaying;
	}

	private beginDragFromPending({ pending }: { pending: PendingGesture }): void {
		const dragTarget = pending.selectedHit ?? pending.topmostHit;
		if (!dragTarget) {
			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: pending });
			return;
		}

		const dragSelection = buildDragSelection({
			selectedClips: pending.selectedClips,
			dragTarget,
		});
		const draggableClips = toDragClipSnapshots({
			clipsWithTracks: this.deps.timeline.getClipsWithTracks({
				clips: dragSelection,
			}),
		});

		if (draggableClips.length === 0) {
			this.gesture = IDLE_GESTURE;
			this.clearSnapLines();
			this.releaseCapturedPointer({ pointerState: pending });
			return;
		}

		if (pending.selectedHit === null) {
			this.deps.selection.setSelected([
				{
					trackId: dragTarget.trackId,
					clipId: dragTarget.clipId,
				},
			]);
		}

		this.gesture = {
			kind: "dragging",
			origin: pending.origin,
			pointerId: pending.pointerId,
			captureTarget: pending.captureTarget,
			bounds: {
				width: dragTarget.bounds.width,
				height: dragTarget.bounds.height,
				rotation: dragTarget.bounds.rotation,
			},
			clips: draggableClips,
		};
		this.notify();
	}

	private updateDragPreview({
		drag,
		currentPos,
	}: {
		drag: DraggingGesture;
		currentPos: Point;
	}): void {
		const firstClip = drag.clips[0];
		if (!firstClip) return;

		const deltaX = currentPos.x - drag.origin.x;
		const deltaY = currentPos.y - drag.origin.y;

		const proposedPosition = {
			x: firstClip.initialTransform.position.x + deltaX,
			y: firstClip.initialTransform.position.y + deltaY,
		};

		const shouldSnap = !this.deps.input.isShiftHeld();
		const snapThreshold = this.deps.viewport.screenPixelsToLogicalThreshold({
			screenPixels: SNAP_THRESHOLD_SCREEN_PIXELS,
		});
		const { snappedPosition, activeLines } = shouldSnap
			? snapPosition({
					proposedPosition,
					canvasSize: this.deps.sequence.getCanvasSize(),
					clipSize: drag.bounds,
					rotation: drag.bounds.rotation,
					snapThreshold,
				})
			: {
					snappedPosition: proposedPosition,
					activeLines: [] as SnapLine[],
				};

		this.deps.preview.onSnapLinesChange?.(activeLines);

		const deltaSnappedX =
			snappedPosition.x - firstClip.initialTransform.position.x;
		const deltaSnappedY =
			snappedPosition.y - firstClip.initialTransform.position.y;

		this.deps.timeline.previewClips(
			drag.clips.map(({ trackId, clipId, initialTransform, initialParams }) => ({
				trackId,
				clipId,
				updates: {
					params: {
						...initialParams,
						"transform.positionX": initialTransform.position.x + deltaSnappedX,
						"transform.positionY": initialTransform.position.y + deltaSnappedY,
					},
				},
			})),
		);
	}
}
