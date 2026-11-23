"use client";

import { useEffect, useState } from "react";
import type { EditorCore } from "@/core";
import { useEditor } from "@/editor/use-editor";
import { RemovalMarkerPopover } from "./removal-marker-popover";
import type { MarkerDragState } from "../hooks/use-marker-drag";
import { DEFAULT_TIMELINE_MARKER_COLOR } from "@/timeline/components/theme";
import { TIMELINE_MARKER_ROW_HEIGHT_PX } from "@/timeline/components/layout";
import { DEFAULT_FPS } from "@/fps/defaults";
import {
	ArrowTurnBackwardIcon,
	Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Marker } from "@/timeline";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/ui/color-picker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { uppercase } from "@/utils/string";
import { clamp, formatNumberForDisplay } from "@/utils/math";
import { timelineTimeToPixels, timelineTimeToSnappedPixels } from "@/timeline";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	snapSeekMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

const MIN_MARKER_WIDTH_PX = 2;
const MARKER_WIDTH_PX = 12;
const MARKER_HEIGHT_PX = 15;
const MARKER_HALF_WIDTH_PX = MARKER_WIDTH_PX / 2;
const REMOVAL_MARKER_CLIP_PATH = "polygon(50% 4%, 100% 50%, 50% 96%, 0% 50%)";
const REMOVAL_MARKER_COLOR = "#fbbf24";
const MARKER_CLIP_PATH =
	"polygon(50% 100%, 12% 72%, 12% 10%, 88% 10%, 88% 72%)";

function seekToMarkerTime({
	editor,
	time,
}: {
	editor: EditorCore;
	time: MediaTime;
}) {
	const activeProject = editor.project.getActive();
	const duration = editor.timeline.getTotalDuration();
	const rate = activeProject?.settings.fps ?? DEFAULT_FPS;
	const snappedTime = snapSeekMediaTime({ time, duration, fps: rate });
	editor.playback.seek({ time: snappedTime });
}

interface TimelineMarkersRowProps {
	zoomLevel: number;
	dynamicTimelineWidth: number;
	dragState: MarkerDragState;
	onMarkerMouseDown: (params: {
		event: React.MouseEvent;
		marker: Marker;
	}) => void;
	handleWheel: (event: React.WheelEvent) => void;
	handleTimelineContentClick: (event: React.MouseEvent) => void;
	handleRulerTrackingMouseDown: (event: React.MouseEvent) => void;
	handleRulerMouseDown: (event: React.MouseEvent) => void;
}

export function TimelineMarkersRow({
	zoomLevel,
	dynamicTimelineWidth,
	dragState,
	onMarkerMouseDown,
	handleWheel,
	handleTimelineContentClick,
	handleRulerTrackingMouseDown,
	handleRulerMouseDown,
}: TimelineMarkersRowProps) {
	const markers = useEditor((e) => e.sequences.getActiveSequence().markers);
	const ordinaryTimes = new Set(
		markers.filter((marker) => !marker.data).map(({ time }) => time),
	);

	return (
		<div
			className="relative flex-1 overflow-hidden"
			style={{ height: TIMELINE_MARKER_ROW_HEIGHT_PX }}
			onWheel={handleWheel}
		>
			<button
				className="relative w-full cursor-default select-none border-0 bg-transparent p-0"
				style={{
					height: TIMELINE_MARKER_ROW_HEIGHT_PX,
					width: `${dynamicTimelineWidth}px`,
				}}
				aria-label="Timeline ruler"
				type="button"
				onClick={handleTimelineContentClick}
				onMouseDown={(event) => {
					handleRulerMouseDown(event);
					handleRulerTrackingMouseDown(event);
				}}
			/>
			{markers.map((marker) => (
				<TimelineMarker
					key={marker.id ?? `marker-${marker.time}`}
					marker={marker}
					overlapsOrdinaryMarker={ordinaryTimes.has(marker.time)}
					zoomLevel={zoomLevel}
					dragState={dragState}
					onMarkerMouseDown={onMarkerMouseDown}
				/>
			))}
		</div>
	);
}

function TimelineMarker({
	marker,
	overlapsOrdinaryMarker,
	zoomLevel,
	dragState,
	onMarkerMouseDown,
}: {
	marker: Marker;
	overlapsOrdinaryMarker: boolean;
	zoomLevel: number;
	dragState: MarkerDragState;
	onMarkerMouseDown: (params: {
		event: React.MouseEvent;
		marker: Marker;
	}) => void;
}) {
	const editor = useEditor();
	const duration = editor.timeline.getTotalDuration();
	const [isPopoverOpen, setIsPopoverOpen] = useState(false);

	const isDragging =
		dragState.isDragging &&
		dragState.markerTime !== null &&
		dragState.markerTime === marker.time &&
		dragState.markerId === marker.id;

	const displayTime = isDragging ? dragState.currentTime : marker.time;
	const time = marker.time;
	const markerDuration = marker.duration ?? ZERO_MEDIA_TIME;
	const durationWidth =
		markerDuration > 0
			? timelineTimeToPixels({ time: markerDuration, zoomLevel })
			: 0;
	const hasDurationRange = durationWidth > MIN_MARKER_WIDTH_PX;
	const markerWidth =
		MARKER_WIDTH_PX + (marker.data ? 0 : Math.max(durationWidth, 0));
	const left = timelineTimeToSnappedPixels({ time: displayTime, zoomLevel });
	const markerLeft = left - MARKER_HALF_WIDTH_PX;
	const rightHalfLeft = MARKER_HALF_WIDTH_PX + Math.max(durationWidth, 0);
	const iconColor = marker.data
		? REMOVAL_MARKER_COLOR
		: (marker.color ?? DEFAULT_TIMELINE_MARKER_COLOR);
	const clipPath = marker.data ? REMOVAL_MARKER_CLIP_PATH : MARKER_CLIP_PATH;

	const handleSeek = () => seekToMarkerTime({ editor, time });

	const handleClick = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (marker.data || event.detail === 2) {
			setIsPopoverOpen(true);
		} else {
			handleSeek();
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		if (marker.data) setIsPopoverOpen(true);
		else handleSeek();
	};

	const handleMouseDown = (event: React.MouseEvent) => {
		onMarkerMouseDown({ event, marker });
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
			<PopoverAnchor asChild>
				<button
					className={`absolute top-0 h-full min-w-0.5 border-0 bg-transparent p-0 ${marker.data && overlapsOrdinaryMarker ? "z-10" : ""}`}
					style={{
						left: `${markerLeft}px`,
						width: `${markerWidth}px`,
					}}
					aria-label={`${marker.data ? `Removal marker: ${marker.data.sectionName}` : "Marker"} at ${formatNumberForDisplay({ value: mediaTimeToSeconds({ time }), fractionDigits: 1 })}s`}
					aria-haspopup={marker.data ? "dialog" : undefined}
					aria-expanded={marker.data ? isPopoverOpen : undefined}
					type="button"
					onMouseDown={handleMouseDown}
					onContextMenu={(event) => {
						if (!marker.data) return;
						event.preventDefault();
						event.stopPropagation();
						setIsPopoverOpen(true);
					}}
					onClick={handleClick}
					onKeyDown={handleKeyDown}
				>
					{hasDurationRange ? (
						<div
							className="pointer-events-none absolute opacity-30"
							style={{
								top: 1.5,
								height: MARKER_HEIGHT_PX - 2.5,
								left: MARKER_HALF_WIDTH_PX,
								width: durationWidth,
								backgroundColor: iconColor,
							}}
						/>
					) : null}
					<div
						className="pointer-events-none absolute top-0 overflow-hidden"
						style={{
							left: 0,
							width: MARKER_HALF_WIDTH_PX,
							height: MARKER_HEIGHT_PX,
						}}
					>
						<div
							className="absolute inset-0"
							style={{
								width: MARKER_WIDTH_PX,
								height: MARKER_HEIGHT_PX,
								clipPath,
								backgroundColor: "hsl(var(--background))",
							}}
						/>
						<div
							className="absolute"
							style={{
								top: 1,
								left: 1,
								width: MARKER_WIDTH_PX - 2,
								height: MARKER_HEIGHT_PX - 2,
								clipPath,
								backgroundColor: iconColor,
							}}
						/>
					</div>
					<div
						className={`absolute top-0 overflow-hidden ${marker.data ? "pointer-events-auto" : "pointer-events-none"}`}
						style={{
							left: rightHalfLeft,
							width: MARKER_HALF_WIDTH_PX,
							height: MARKER_HEIGHT_PX,
						}}
					>
						<div
							className="absolute top-0"
							style={{
								left: -MARKER_HALF_WIDTH_PX,
								width: MARKER_WIDTH_PX,
								height: MARKER_HEIGHT_PX,
								clipPath,
								backgroundColor: "hsl(var(--background))",
							}}
						/>
						<div
							className="absolute"
							style={{
								top: 1,
								left: 1 - MARKER_HALF_WIDTH_PX,
								width: MARKER_WIDTH_PX - 2,
								height: MARKER_HEIGHT_PX - 2,
								clipPath,
								backgroundColor: iconColor,
							}}
						/>
					</div>
				</button>
			</PopoverAnchor>
			<PopoverContent
				className="w-64 flex flex-col gap-3 p-3"
				align="start"
				side="bottom"
				sideOffset={8}
				onOpenAutoFocus={(event) => {
					if (!marker.data) event.preventDefault();
				}}
			>
				{marker.data ? (
					<RemovalMarkerPopover marker={marker} />
				) : (
					<MarkerPopoverContent
						marker={marker}
						time={time}
						timelineDuration={duration}
						onPopoverClose={() => setIsPopoverOpen(false)}
					/>
				)}
			</PopoverContent>
		</Popover>
	);
}

function MarkerPopoverContent({
	marker,
	time,
	timelineDuration,
	onPopoverClose,
}: {
	marker: Marker;
	time: MediaTime;
	timelineDuration: MediaTime;
	onPopoverClose: () => void;
}) {
	const editor = useEditor();
	const [draftColorHex, setDraftColorHex] = useState(
		(marker.color ?? DEFAULT_TIMELINE_MARKER_COLOR)
			.replace("#", "")
			.toUpperCase(),
	);

	useEffect(() => {
		setDraftColorHex(
			(marker.color ?? DEFAULT_TIMELINE_MARKER_COLOR)
				.replace("#", "")
				.toUpperCase(),
		);
	}, [marker.color]);

	const handleRemove = () => {
		editor.sequences.removeMarker({ time });
		onPopoverClose();
	};

	const handleUpdate = ({
		note,
		color,
		duration,
	}: Partial<Pick<Marker, "note" | "color" | "duration">>) => {
		const updates: Partial<Pick<Marker, "note" | "color" | "duration">> = {};
		if (note !== undefined && note !== marker.note) updates.note = note;
		if (
			color !== undefined &&
			color.toUpperCase() !== (marker.color ?? "").toUpperCase()
		) {
			updates.color = color;
		}
		if (duration !== undefined && duration !== marker.duration) {
			updates.duration = duration;
		}
		if (Object.keys(updates).length === 0) return;
		editor.sequences.updateMarker({ time, updates });
	};
	const maxDuration = mediaTimeToSeconds({
		time:
			timelineDuration > time
				? subMediaTime({ a: timelineDuration, b: time })
				: ZERO_MEDIA_TIME,
	});
	const durationSeconds = mediaTimeToSeconds({
		time: marker.duration ?? ZERO_MEDIA_TIME,
	});

	return (
		<>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">Note</Label>
				<Input
					placeholder="Add a note..."
					value={marker.note ?? ""}
					onChange={(event) => handleUpdate({ note: event.target.value })}
					className="h-8 text-sm"
				/>
			</div>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">Color</Label>
				<div className="relative">
					<ColorPicker
						value={uppercase({ string: draftColorHex })}
						onChange={(color) => setDraftColorHex(uppercase({ string: color }))}
						onChangeEnd={(color) =>
							handleUpdate({ color: `#${uppercase({ string: color })}` })
						}
						className="bg-background border"
					/>
					{marker.color &&
						marker.color.replace(/^#/, "").toUpperCase() !==
							DEFAULT_TIMELINE_MARKER_COLOR.replace(
								/^#/,
								"",
							).toUpperCase() && (
							<Button
								type="button"
								variant="text"
								size="text"
								aria-label="Reset to default color"
								className="absolute top-1/2 right-1 -translate-y-1/2 mr-1"
								onClick={() =>
									editor.sequences.updateMarker({
										time,
										updates: { color: undefined },
									})
								}
							>
								<HugeiconsIcon
									icon={ArrowTurnBackwardIcon}
									className="!size-3.5"
								/>
							</Button>
						)}
				</div>
			</div>
			<div className="flex flex-col gap-2">
				<Label className="text-xs">Duration</Label>
				<div className="flex items-center gap-1.5">
					<Input
						type="number"
						min={0}
						step={0.1}
						value={durationSeconds}
						onChange={(event) => {
							const parsed = parseFloat(event.target.value);
							const value = Number.isNaN(parsed)
								? 0
								: clamp({
										value: parsed,
										min: 0,
										max: maxDuration,
									});
							handleUpdate({
								duration: mediaTimeFromSeconds({ seconds: value }),
							});
						}}
						className="h-8 text-sm"
						containerClassName="w-full"
					/>
				</div>
			</div>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="text-destructive hover:bg-destructive/10"
				onClick={handleRemove}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						handleRemove();
					}
				}}
				aria-label="delete marker"
			>
				<HugeiconsIcon icon={Delete02Icon} className="!size-3.5" />
				Delete
			</Button>
		</>
	);
}
