"use client";

import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import { TimelineClip } from "./timeline-clip";
import type { TimelineTrack } from "@/timeline";
import type { TimelineClip as TimelineClipType } from "@/timeline";
import { TIMELINE_LAYERS } from "./layers";
import type { ClipDragView } from "@/timeline";

interface TimelineTrackContentProps {
	track: TimelineTrack;
	zoomLevel: number;
	dragView: ClipDragView;
	onResizeStart: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onClipMouseDown: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
	}) => void;
	onClipClick: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
	}) => void;
	onTrackMouseDown?: (event: React.MouseEvent) => void;
	onTrackMouseUp?: (event: React.MouseEvent) => void;
	shouldIgnoreClick?: () => boolean;
	targetClipId?: string | null;
}

export function TimelineTrackContent({
	track,
	zoomLevel,
	dragView,
	onResizeStart,
	onClipMouseDown,
	onClipClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	targetClipId = null,
}: TimelineTrackContentProps) {
	const { isClipSelected } = useClipSelection();

	return (
		<div className="relative size-full">
			<button
				type="button"
				className="absolute inset-0 m-0 size-full appearance-none border-0 bg-transparent p-0"
				aria-label={`Select ${track.name} track`}
				onMouseUp={(event) => {
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			/>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial gesture surface; the wrapping <button> handles keyboard track selection, this <div> only forwards background clicks for box-select / deselect. */}
			<div
				className="relative h-full min-w-full"
				style={{ zIndex: TIMELINE_LAYERS.trackContent }}
				onMouseUp={(event) => {
					if (event.target !== event.currentTarget) return;
					if (shouldIgnoreClick?.()) return;
					onTrackMouseUp?.(event);
				}}
				onMouseDown={(event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onTrackMouseDown?.(event);
				}}
			>
				{track.clips.length === 0 ? (
					<div className="text-muted-foreground border-muted/30 pointer-events-none flex size-full items-center justify-center rounded-sm border-2 border-dashed text-xs" />
				) : (
					track.clips.map((clip) => {
						const isSelected = isClipSelected({
							trackId: track.id,
							clipId: clip.id,
						});

						return (
							<TimelineClip
								key={clip.id}
								clip={clip}
								track={track}
								zoomLevel={zoomLevel}
								isSelected={isSelected}
								onResizeStart={({ event, clip, side }) =>
									onResizeStart({ event, clip, track, side })
								}
								onClipMouseDown={({ event, clip }) =>
									onClipMouseDown({ event, clip, track })
								}
								onClipClick={({ event, clip }) =>
									onClipClick({ event, clip, track })
								}
								dragView={dragView}
								isDropTarget={clip.id === targetClipId}
							/>
						);
					})
				)}
			</div>
		</div>
	);
}
