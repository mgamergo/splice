import type { TimelineTrack } from "@/timeline";
import { timelineTimeToPixels } from "@/timeline/pixel-utils";
import {
	TIMELINE_CONTENT_TOP_PADDING_PX,
} from "./layout";
import { getCumulativeHeightBefore, getTrackHeight } from "./track-layout";

type TimelineClipRef = { trackId: string; clipId: string };

interface SelectionRectangle {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function getNormalizedRectangle({
	startPos,
	endPos,
}: {
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	return {
		left: Math.min(startPos.x, endPos.x),
		top: Math.min(startPos.y, endPos.y),
		right: Math.max(startPos.x, endPos.x),
		bottom: Math.max(startPos.y, endPos.y),
	};
}

function getSelectionRectangleInContent({
	container,
	scrollContainer,
	startPos,
	endPos,
}: {
	container: HTMLElement;
	scrollContainer: HTMLDivElement | null;
	startPos: { x: number; y: number };
	endPos: { x: number; y: number };
}): SelectionRectangle {
	const containerRect = container.getBoundingClientRect();
	const scrollRect = scrollContainer?.getBoundingClientRect() ?? containerRect;
	const scrollLeft = scrollContainer?.scrollLeft ?? 0;
	const scrollTop = scrollContainer?.scrollTop ?? 0;

	const adjustedStart = {
		x: startPos.x - containerRect.left + scrollLeft,
		y: startPos.y - scrollRect.top + scrollTop,
	};
	const adjustedEnd = {
		x: endPos.x - containerRect.left + scrollLeft,
		y: endPos.y - scrollRect.top + scrollTop,
	};

	return getNormalizedRectangle({
		startPos: adjustedStart,
		endPos: adjustedEnd,
	});
}

function isRectangleIntersecting({
	clipRectangle,
	selectionRectangle,
}: {
	clipRectangle: SelectionRectangle;
	selectionRectangle: SelectionRectangle;
}): boolean {
	return !(
		clipRectangle.right < selectionRectangle.left ||
		clipRectangle.left > selectionRectangle.right ||
		clipRectangle.bottom < selectionRectangle.top ||
		clipRectangle.top > selectionRectangle.bottom
	);
}

export function resolveTimelineClipIntersections({
	container,
	scrollContainer,
	tracks,
	zoomLevel,
	startPos,
	currentPos,
}: {
	container: HTMLElement;
	scrollContainer: HTMLDivElement | null;
	tracks: TimelineTrack[];
	zoomLevel: number;
	startPos: { x: number; y: number };
	currentPos: { x: number; y: number };
}): TimelineClipRef[] {
	const selectionRectangle = getSelectionRectangleInContent({
		container,
		scrollContainer,
		startPos,
		endPos: currentPos,
	});
	const selectedClips: TimelineClipRef[] = [];

	for (const [trackIndex, track] of tracks.entries()) {
		const trackTop = getCumulativeHeightBefore({
			tracks,
			trackIndex,
		});
		const trackHeight = getTrackHeight({ type: track.type });
		const clipTop = TIMELINE_CONTENT_TOP_PADDING_PX + trackTop;
		const clipBottom = clipTop + trackHeight;

		for (const clip of track.clips) {
			const clipLeft = timelineTimeToPixels({ time: clip.startTime, zoomLevel });
			const clipRight = timelineTimeToPixels({ time: clip.startTime + clip.duration, zoomLevel });
			const clipRectangle = {
				left: clipLeft,
				top: clipTop,
				right: clipRight,
				bottom: clipBottom,
			};

			if (
				isRectangleIntersecting({
					clipRectangle,
					selectionRectangle,
				})
			) {
				selectedClips.push({
					trackId: track.id,
					clipId: clip.id,
				});
			}
		}
	}

	return selectedClips;
}
