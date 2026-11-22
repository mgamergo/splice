import {
	useState,
	useCallback,
	useEffect,
	useRef,
	type RefObject,
} from "react";
import { useEditor } from "@/editor/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getMarkerSnapPoints } from "../snap-source";
import { getClipEdgeSnapPoints } from "@/timeline/clip-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import type { Marker } from "@/timeline";
import { roundFrameTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export interface MarkerDragState {
	isDragging: boolean;
	markerTime: MediaTime | null;
	currentTime: MediaTime;
}

interface PendingMarkerDrag {
	markerTime: MediaTime;
	startMouseX: number;
	startMouseY: number;
}

interface UseMarkerDragProps {
	zoomLevel: number;
	scrollRef: RefObject<HTMLElement | null>;
	snappingEnabled: boolean;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export function useMarkerDrag({
	zoomLevel,
	scrollRef,
	snappingEnabled,
	onSnapPointChange,
}: UseMarkerDragProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const tracks = editor.sequences.getActiveSequence().tracks;
	const activeSequence = editor.sequences.getActiveSequence();
	const markers = activeSequence?.markers ?? [];
	const playheadTime = editor.playback.getCurrentTime();
	const duration = editor.timeline.getTotalDuration();

	const [dragState, setDragState] = useState<MarkerDragState>({
		isDragging: false,
		markerTime: null,
		currentTime: ZERO_MEDIA_TIME,
	});
	const [isPendingDrag, setIsPendingDrag] = useState(false);
	const pendingDragRef = useRef<PendingMarkerDrag | null>(null);
	const lastMouseXRef = useRef(0);

	const startDrag = useCallback(
		({
			markerTime,
			initialCurrentTime,
		}: {
			markerTime: MediaTime;
			initialCurrentTime: MediaTime;
		}) => {
			setDragState({
				isDragging: true,
				markerTime,
				currentTime: initialCurrentTime,
			});
		},
		[],
	);

	const endDrag = useCallback(() => {
		setDragState({
			isDragging: false,
			markerTime: null,
			currentTime: ZERO_MEDIA_TIME,
		});
	}, []);

	const getSnapResult = useCallback(
		({
			rawTime,
			excludeMarkerTime,
		}: {
			rawTime: MediaTime;
			excludeMarkerTime: MediaTime;
		}): { snappedTime: MediaTime; snapPoint: SnapPoint | null } => {
			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			if (!shouldSnap) {
				return { snappedTime: rawTime, snapPoint: null };
			}

			const snapPoints = buildTimelineSnapPoints({
				sources: [
					() => getClipEdgeSnapPoints({ tracks }),
					() => getPlayheadSnapPoints({ playheadTime }),
					() => getMarkerSnapPoints({ markers, excludeMarkerTime }),
					() => getAnimationKeyframeSnapPointsForTimeline({ tracks }),
				],
			});
			const result = resolveTimelineSnap({
				targetTime: rawTime,
				snapPoints,
				maxSnapDistance: getTimelineSnapThresholdInTicks({ zoomLevel }),
			});
			return {
				snappedTime: result.snappedTime,
				snapPoint: result.snapPoint,
			};
		},
		[
			snappingEnabled,
			tracks,
			playheadTime,
			markers,
			zoomLevel,
			isShiftHeldRef,
		],
	);

	useEffect(() => {
		if (!dragState.isDragging && !isPendingDrag) return;

		const handleMouseMove = (event: MouseEvent) => {
			lastMouseXRef.current = event.clientX;

			const scrollContainer = scrollRef.current;
			if (!scrollContainer) return;

			if (isPendingDrag && pendingDragRef.current) {
				const { startMouseX, startMouseY, markerTime } =
					pendingDragRef.current;
				const deltaX = Math.abs(event.clientX - startMouseX);
				const deltaY = Math.abs(event.clientY - startMouseY);

				if (
					deltaX <= TIMELINE_DRAG_THRESHOLD_PX &&
					deltaY <= TIMELINE_DRAG_THRESHOLD_PX
				) {
					return;
				}

				const activeProject = editor.project.getActive();
				if (!activeProject) return;

				const scrollLeft = scrollContainer.scrollLeft;
				const mouseTime = getMouseTimeFromClientX({
					clientX: event.clientX,
					containerRect: scrollContainer.getBoundingClientRect(),
					zoomLevel,
					scrollLeft,
				});
				const clampedTime =
					mouseTime > duration ? duration : mouseTime;
				const frameSnappedTime = roundFrameTime({
					time: clampedTime,
					fps: activeProject.settings.fps,
				});
				const { snappedTime: initialTime } = getSnapResult({
					rawTime: frameSnappedTime,
					excludeMarkerTime: markerTime,
				});

				startDrag({
					markerTime,
					initialCurrentTime: initialTime,
				});
				pendingDragRef.current = null;
				setIsPendingDrag(false);
				return;
			}

			if (!dragState.isDragging || dragState.markerTime === null) return;

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			const scrollLeft = scrollContainer.scrollLeft;
			const mouseTime = getMouseTimeFromClientX({
				clientX: event.clientX,
				containerRect: scrollContainer.getBoundingClientRect(),
				zoomLevel,
				scrollLeft,
			});
			const clampedTime =
				mouseTime > duration ? duration : mouseTime;
			const frameSnappedTime = roundFrameTime({
				time: clampedTime,
				fps: activeProject.settings.fps,
			});
			const snapResult = getSnapResult({
				rawTime: frameSnappedTime,
				excludeMarkerTime: dragState.markerTime,
			});

			setDragState((previousDragState) => ({
				...previousDragState,
				currentTime: snapResult.snappedTime,
			}));
			onSnapPointChange?.(snapResult.snapPoint);
		};

		document.addEventListener("mousemove", handleMouseMove);
		return () => document.removeEventListener("mousemove", handleMouseMove);
	}, [
		dragState.isDragging,
		dragState.markerTime,
		zoomLevel,
		duration,
		editor.project,
		scrollRef,
		isPendingDrag,
		startDrag,
		getSnapResult,
		onSnapPointChange,
	]);

	useEffect(() => {
		if (!dragState.isDragging) return;

		const handleMouseUp = () => {
			if (dragState.markerTime === null) {
				endDrag();
				onSnapPointChange?.(null);
				return;
			}

			const clampedTime =
				dragState.currentTime > duration ? duration : dragState.currentTime;

			editor.sequences.moveMarker({
				fromTime: dragState.markerTime,
				toTime: clampedTime,
			});

			endDrag();
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [
		dragState.isDragging,
		dragState.markerTime,
		dragState.currentTime,
		duration,
		endDrag,
		onSnapPointChange,
		editor.sequences,
	]);

	useEffect(() => {
		if (!isPendingDrag) return;

		const handleMouseUp = () => {
			pendingDragRef.current = null;
			setIsPendingDrag(false);
			onSnapPointChange?.(null);
		};

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [isPendingDrag, onSnapPointChange]);

	const handleMarkerMouseDown = useCallback(
		({ event, marker }: { event: React.MouseEvent; marker: Marker }) => {
			if (event.button !== 0) return;

			event.preventDefault();
			event.stopPropagation();

			pendingDragRef.current = {
				markerTime: marker.time,
				startMouseX: event.clientX,
				startMouseY: event.clientY,
			};
			setIsPendingDrag(true);
		},
		[],
	);

	return {
		dragState,
		handleMarkerMouseDown,
		lastMouseXRef,
	};
}
