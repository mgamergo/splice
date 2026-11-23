"use client";

import { createContext, useContext } from "react";
import { useEditor } from "@/editor/use-editor";
import { useLibraryPanelStore } from "@/components/editor/panels/library/library-panel-store";
import { AudioWaveform, WAVEFORM_GAIN_SAMPLE_COUNT } from "./audio-waveform";
import { AudioVolumeLine } from "./audio-volume-line";
import { useClipPreview } from "@/timeline/hooks/use-clip-preview";
import {
	useKeyframeDrag,
	type KeyframeDragState,
} from "@/timeline/hooks/clip/use-keyframe-drag";
import { useKeyframeSelection } from "@/timeline/hooks/clip/use-keyframe-selection";
import { useKeyframeBoxSelect } from "@/timeline/hooks/clip/use-keyframe-box-select";
import { SelectionBox } from "@/selection/selection-box";
import { getClipKeyframes } from "@/animation";
import {
	canClipHaveAudio,
	canClipBeHidden,
	hasClipEffects,
	hasMediaId,
	timelineTimeToPixels,
	timelineTimeToSnappedPixels,
} from "@/timeline";
import { getTrackHeight } from "./track-layout";
import { getTimelineClipClassName, TIMELINE_TRACK_THEME } from "./theme";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SelectionBoxBounds } from "@/selection/types";
import type {
	TimelineClip as TimelineClipType,
	TimelineTrack,
	ClipDragView,
	VideoClip,
	ImageClip,
	AudioClip,
} from "@/timeline";
import type { ProjectItem } from "@/media/types";
import { mediaSupportsAudio } from "@/media/media-utils";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { buildWaveformGainSamples, isClipMuted } from "@/timeline/audio-state";
import { getTimelinePixelsPerSecond } from "@/timeline";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { addMediaTime, type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import {
	getActionDefinition,
	type TAction,
	type TActionWithOptionalArgs,
	invokeAction,
} from "@/actions";
import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import { resolveStickerId } from "@/stickers";
import { buildGraphicPreviewUrl } from "@/graphics";
import Image from "next/image";
import {
	ScissorIcon,
	Delete02Icon,
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
	VolumeMute02Icon,
	Search01Icon,
	Exchange01Icon,
	KeyframeIcon,
	MagicWand05Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { uppercase } from "@/utils/string";
import { useMemo, type ComponentProps, type ReactNode } from "react";
import type { SelectedKeyframeRef, ClipKeyframe } from "@/animation/types";
import { cn } from "@/utils/ui";
import { usePropertiesStore } from "@/components/editor/panels/properties/stores/properties-store";
import { getTrackTypeForClipType } from "@/timeline/placement/compatibility";
import { useTimelineStore } from "@/timeline/timeline-store";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";
import {
	getExpandedRows,
	getExpansionHeight,
	type ExpandedRow,
} from "./expanded-layout";

const KEYFRAME_INDICATOR_MIN_WIDTH_PX = 40;
const CLIP_RING_WIDTH_PX = 1.5;

const PixelsPerSecondContext = createContext<number | null>(null);
const THUMBNAIL_ASPECT_RATIO = 16 / 9;

interface KeyframeIndicator {
	time: MediaTime;
	offsetPx: number;
	keyframes: SelectedKeyframeRef[];
}

export function buildKeyframeIndicator({
	keyframe,
	trackId,
	clipId,
	displayedStartTime,
	zoomLevel,
	clipLeft,
}: {
	keyframe: ClipKeyframe;
	trackId: string;
	clipId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	clipLeft: number;
}): {
	time: MediaTime;
	offsetPx: number;
	keyframeRef: SelectedKeyframeRef;
} {
	const keyframeRef = {
		trackId,
		clipId,
		propertyPath: keyframe.propertyPath,
		keyframeId: keyframe.id,
	};
	const keyframeLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime + keyframe.time,
		zoomLevel,
	});
	return {
		time: keyframe.time,
		offsetPx: keyframeLeft - clipLeft,
		keyframeRef,
	};
}

export function getKeyframeIndicators({
	keyframes,
	trackId,
	clipId,
	displayedStartTime,
	zoomLevel,
	clipLeft,
	clipWidth,
}: {
	keyframes: ClipKeyframe[];
	trackId: string;
	clipId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	clipLeft: number;
	clipWidth: number;
}): KeyframeIndicator[] {
	if (clipWidth < KEYFRAME_INDICATOR_MIN_WIDTH_PX) {
		return [];
	}

	const keyframesByTime = new Map<MediaTime, KeyframeIndicator>();
	for (const keyframe of keyframes) {
		const indicator = buildKeyframeIndicator({
			keyframe,
			trackId,
			clipId,
			displayedStartTime,
			zoomLevel,
			clipLeft,
		});
		const existingIndicator = keyframesByTime.get(indicator.time);
		if (!existingIndicator) {
			keyframesByTime.set(indicator.time, {
				time: indicator.time,
				offsetPx: indicator.offsetPx,
				keyframes: [indicator.keyframeRef],
			});
			continue;
		}

		existingIndicator.keyframes.push(indicator.keyframeRef);
	}

	return [...keyframesByTime.values()].sort((a, b) => a.time - b.time);
}

export function getDisplayShortcut({ action }: { action: TAction }) {
	const defaultShortcuts = getActionDefinition({ action }).defaultShortcuts;
	if (!defaultShortcuts?.length) {
		return "";
	}

	return uppercase({
		string: defaultShortcuts[0].replace("+", " "),
	});
}

interface TimelineClipProps {
	clip: TimelineClipType;
	track: TimelineTrack;
	zoomLevel: number;
	isSelected: boolean;
	onResizeStart: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	onClipMouseDown: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
	}) => void;
	onClipClick: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
	}) => void;
	dragView: ClipDragView;
	isDropTarget?: boolean;
}

export function TimelineClip({
	clip,
	track,
	zoomLevel,
	isSelected,
	onResizeStart,
	onClipMouseDown,
	onClipClick,
	dragView,
	isDropTarget = false,
}: TimelineClipProps) {
	const projectItems = useEditor((e) => e.media.getProjectItems());
	const { selectedClips } = useClipSelection();
	const requestRevealMedia = useLibraryPanelStore((s) => s.requestRevealMedia);
	const { renderClip } = useClipPreview({
		trackId: track.id,
		clipId: clip.id,
		fallback: clip,
	});

	let projectItem: ProjectItem | null = null;

	if (hasMediaId(clip)) {
		projectItem =
			projectItems.find((projectItem) => projectItem.id === clip.mediaId) ?? null;
	}

	const hasAudio = mediaSupportsAudio({ media: projectItem });

	const isCurrentClipSelected = selectedClips.some(
		(selected) =>
			selected.clipId === clip.id && selected.trackId === track.id,
	);

	const isDragging = dragView.kind === "dragging";
	const dragTimeOffset = isDragging
		? dragView.memberTimeOffsets.get(clip.id)
		: undefined;
	const isBeingDragged = dragTimeOffset !== undefined;
	const dragOffsetY =
		isDragging && isBeingDragged
			? dragView.currentMouseY - dragView.startMouseY
			: 0;
	const clipStartTime =
		isDragging && isBeingDragged
			? addMediaTime({ a: dragView.currentTime, b: dragTimeOffset })
			: renderClip.startTime;
	const displayedStartTime = clipStartTime;
	const displayedDuration = renderClip.duration;
	const clipWidth = timelineTimeToPixels({
		time: displayedDuration,
		zoomLevel,
	});
	const timelinePixelsPerSecond = getTimelinePixelsPerSecond({ zoomLevel });
	const clipLeft = timelineTimeToSnappedPixels({
		time: displayedStartTime,
		zoomLevel,
	});
	const keyframeIndicators = isSelected
		? getKeyframeIndicators({
				keyframes: getClipKeyframes({ animations: clip.animations }),
				trackId: track.id,
				clipId: clip.id,
				displayedStartTime,
				zoomLevel,
				clipLeft,
				clipWidth,
			})
		: [];

	const {
		keyframeDragState,
		handleKeyframeMouseDown,
		handleKeyframeClick,
		getVisualOffsetPx,
	} = useKeyframeDrag({ zoomLevel, clip, displayedStartTime });

	const clipKeyframes = getClipKeyframes({
		animations: clip.animations,
	});

	const isExpanded = useTimelineStore((s) =>
		s.expandedClipIds.has(clip.id),
	);
	const toggleClipExpanded = useTimelineStore(
		(s) => s.toggleClipExpanded,
	);
	const expandedRows = useMemo(
		() =>
			isExpanded ? getExpandedRows({ animations: clip.animations }) : [],
		[isExpanded, clip.animations],
	);

	const {
		containerRef: expandedLanesRef,
		selectionBox: keyframeSelectionBox,
		isBoxSelecting: isKeyframeBoxSelecting,
		handleExpandedAreaMouseDown,
		handleExpandedAreaClick,
	} = useKeyframeBoxSelect({
		trackId: track.id,
		clipId: clip.id,
		rows: expandedRows,
		keyframes: clipKeyframes,
		displayedStartTime,
		zoomLevel,
		clipLeft,
	});

	const handleRevealInMedia = ({ event }: { event: React.MouseEvent }) => {
		event.stopPropagation();
		if (hasMediaId(clip)) {
			requestRevealMedia(clip.mediaId);
		}
	};

	const isMuted = canClipHaveAudio(clip) && isClipMuted({ clip });
	const canToggleCurrentSourceAudio =
		selectedClips.length === 1 &&
		isCurrentClipSelected &&
		canToggleSourceAudio(clip, projectItem);
	const sourceAudioLabel =
		clip.type === "video"
			? getSourceAudioActionLabel({ clip })
			: "Extract audio";
	const isClipSourceAudioSeparated =
		clip.type === "video" && isSourceAudioSeparated({ clip });
	const hasKeyframes = clipKeyframes.length > 0;
	const expansionHeight = getExpansionHeight({ rows: expandedRows });
	const baseTrackHeight = getTrackHeight({ type: track.type });

	const expandedContent =
		isExpanded && expandedRows.length > 0 ? (
			<ExpandedKeyframeLanes
				rows={expandedRows}
				keyframes={clipKeyframes}
				trackId={track.id}
				clipId={clip.id}
				displayedStartTime={displayedStartTime}
				zoomLevel={zoomLevel}
				clipLeft={clipLeft}
				keyframeDragState={keyframeDragState}
				onKeyframeMouseDown={handleKeyframeMouseDown}
				onKeyframeClick={handleKeyframeClick}
				getVisualOffsetPx={getVisualOffsetPx}
				containerRef={expandedLanesRef}
				onLaneMouseDown={handleExpandedAreaMouseDown}
				onLaneClick={handleExpandedAreaClick}
				selectionBox={keyframeSelectionBox}
				isBoxSelecting={isKeyframeBoxSelecting}
			/>
		) : null;

	return (
		<PixelsPerSecondContext.Provider value={timelinePixelsPerSecond}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className="absolute top-0 select-none"
						style={{
							left: `${clipLeft}px`,
							width: `${clipWidth}px`,
							height:
								expandedRows.length > 0
									? `${baseTrackHeight + expansionHeight}px`
									: "100%",
							transform:
								isDragging && isBeingDragged
									? `translate3d(0, ${dragOffsetY}px, 0)`
									: undefined,
						}}
					>
						<ClipInner
							clip={clip}
							displayClip={renderClip}
							track={track}
							isSelected={isSelected}
							isExpanded={expandedRows.length > 0}
							baseTrackHeight={baseTrackHeight}
							expandedContent={expandedContent}
							onClipClick={onClipClick}
							onClipMouseDown={onClipMouseDown}
							onResizeStart={onResizeStart}
							isDropTarget={isDropTarget}
						/>
						{isSelected && (
							<div
								className="pointer-events-none absolute inset-x-0 top-0 overflow-hidden"
								style={{ height: `${baseTrackHeight}px` }}
							>
								<KeyframeIndicators
									indicators={keyframeIndicators}
									dragState={keyframeDragState}
									displayedStartTime={displayedStartTime}
									clipLeft={clipLeft}
									onKeyframeMouseDown={handleKeyframeMouseDown}
									onKeyframeClick={handleKeyframeClick}
									getVisualOffsetPx={getVisualOffsetPx}
								/>
							</div>
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-64">
					<ActionMenuItem
						action="razor"
						icon={<HugeiconsIcon icon={ScissorIcon} />}
					>
						Razor
					</ActionMenuItem>
					<CopyMenuItem />
					{selectedClips.length === 1 && (
						<ActionMenuItem
							action="duplicate-selected"
							icon={<HugeiconsIcon icon={Copy01Icon} />}
						>
							Duplicate
						</ActionMenuItem>
					)}
					{canClipHaveAudio(clip) && hasAudio && (
						<MuteMenuItem
							isMultipleSelected={selectedClips.length > 1}
							isCurrentClipSelected={isCurrentClipSelected}
							isMuted={isMuted}
						/>
					)}
					{canToggleCurrentSourceAudio && (
						<ContextMenuItem
							icon={
								<HugeiconsIcon
									icon={
										isClipSourceAudioSeparated ? ScissorIcon : ScissorIcon
									}
								/>
							}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								invokeAction("toggle-source-audio");
							}}
						>
							{sourceAudioLabel}
						</ContextMenuItem>
					)}
					{canClipBeHidden(clip) && (
						<VisibilityMenuItem
							clip={clip}
							isMultipleSelected={selectedClips.length > 1}
							isCurrentClipSelected={isCurrentClipSelected}
						/>
					)}
					{hasKeyframes && (
						<ContextMenuItem
							icon={<HugeiconsIcon icon={KeyframeIcon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								toggleClipExpanded(clip.id);
							}}
						>
							{isExpanded ? "Collapse keyframes" : "Expand keyframes"}
						</ContextMenuItem>
					)}
					{selectedClips.length === 1 && hasMediaId(clip) && (
						<>
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Search01Icon} />}
								onClick={(event: React.MouseEvent) =>
									handleRevealInMedia({ event })
								}
							>
								Reveal media
							</ContextMenuItem>
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Exchange01Icon} />}
								disabled
							>
								Replace media
							</ContextMenuItem>
						</>
					)}
					<ContextMenuSeparator />
					<DeleteMenuItem
						isMultipleSelected={selectedClips.length > 1}
						isCurrentClipSelected={isCurrentClipSelected}
						clipType={clip.type}
						selectedCount={selectedClips.length}
					/>
				</ContextMenuContent>
			</ContextMenu>
		</PixelsPerSecondContext.Provider>
	);
}

function ClipInner({
	clip,
	displayClip,
	track,
	isSelected,
	isExpanded,
	baseTrackHeight,
	expandedContent,
	onClipClick,
	onClipMouseDown,
	onResizeStart,
	isDropTarget = false,
}: {
	clip: TimelineClipType;
	displayClip?: TimelineClipType;
	track: TimelineTrack;
	isSelected: boolean;
	isExpanded: boolean;
	baseTrackHeight: number;
	expandedContent: React.ReactNode;
	onClipClick: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
	}) => void;
	onClipMouseDown: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
	}) => void;
	onResizeStart: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
	isDropTarget?: boolean;
}) {
	const visibleClip = displayClip ?? clip;
	const isReducedOpacity =
		(canClipBeHidden(visibleClip) && visibleClip.hidden) ||
		isDropTarget;
	return (
		<div
			className="absolute top-0 bottom-0"
			style={{
				left: `${CLIP_RING_WIDTH_PX}px`,
				right: `${CLIP_RING_WIDTH_PX}px`,
			}}
		>
			<div
				className="absolute inset-0 rounded-sm"
				style={
					isSelected
						? {
								boxShadow: `0 0 0 ${CLIP_RING_WIDTH_PX}px var(--primary)`,
							}
						: undefined
				}
			>
				<div
					className={cn(
						"absolute inset-0 overflow-hidden rounded-sm",
						isExpanded && "bg-background",
					)}
				>
					<button
						type="button"
						tabIndex={-1}
						className="absolute inset-0 size-full flex flex-col"
						onClick={(event) => onClipClick({ event, clip })}
						onMouseDown={(event) => onClipMouseDown({ event, clip })}
					>
						<div
							className={cn(
								"flex shrink-0 items-center overflow-hidden",
								getTimelineClipClassName({
									type: getTrackTypeForClipType({
										clipType: clip.type,
									}),
								}),
								isReducedOpacity && "opacity-50",
							)}
							style={{ height: `${baseTrackHeight}px` }}
						>
							<div className="flex flex-1 min-h-0 h-full items-center overflow-hidden">
								<ClipContent clip={visibleClip} track={track} />
							</div>
						</div>
						{expandedContent}
					</button>
				</div>
			</div>

			{isSelected && (
				<>
					<ResizeHandle
						side="left"
						clip={clip}
						track={track}
						onResizeStart={onResizeStart}
					/>
					<ResizeHandle
						side="right"
						clip={clip}
						track={track}
						onResizeStart={onResizeStart}
					/>
				</>
			)}
		</div>
	);
}

function ResizeHandle({
	side,
	clip,
	track,
	onResizeStart,
}: {
	side: "left" | "right";
	clip: TimelineClipType;
	track: TimelineTrack;
	onResizeStart: (params: {
		event: React.MouseEvent;
		clip: TimelineClipType;
		track: TimelineTrack;
		side: "left" | "right";
	}) => void;
}) {
	const isLeft = side === "left";
	return (
		<button
			type="button"
			className={cn(
				"absolute top-0 bottom-0 w-2",
				isLeft ? "-left-1 cursor-w-resize" : "-right-1 cursor-e-resize",
			)}
			onMouseDown={(event) => onResizeStart({ event, clip, track, side })}
			onClick={(event) => event.stopPropagation()}
			aria-label={`${isLeft ? "Left" : "Right"} resize handle`}
		></button>
	);
}

function KeyframeIndicators({
	indicators,
	dragState,
	displayedStartTime,
	clipLeft,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
}: {
	indicators: KeyframeIndicator[];
	dragState: KeyframeDragState;
	displayedStartTime: MediaTime;
	clipLeft: number;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		clipLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();
	const orderedKeyframes = indicators.flatMap(
		(indicator) => indicator.keyframes,
	);

	return indicators.map((indicator) => {
		const isIndicatorSelected = indicator.keyframes.some((keyframe) =>
			isKeyframeSelected({ keyframe }),
		);
		const isBeingDragged = indicator.keyframes.some((keyframe) =>
			dragState.draggingKeyframeIds.has(keyframe.keyframeId),
		);
		const visualOffsetPx = getVisualOffsetPx({
			indicatorTime: indicator.time,
			indicatorOffsetPx: indicator.offsetPx,
			isBeingDragged,
			displayedStartTime,
			clipLeft,
		});

		return (
			<button
				key={indicator.time}
				type="button"
				className="pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab mr-0.5"
				style={{ left: visualOffsetPx }}
				onMouseDown={(event) =>
					onKeyframeMouseDown({ event, keyframes: indicator.keyframes })
				}
				onClick={(event) =>
					onKeyframeClick({
						event,
						keyframes: indicator.keyframes,
						orderedKeyframes,
						indicatorTime: indicator.time,
					})
				}
				aria-label="Select keyframe"
			>
				<HugeiconsIcon
					icon={KeyframeIcon}
					className={cn(
						"size-3.5 text-black",
						isIndicatorSelected ? "fill-primary" : "fill-white",
					)}
					strokeWidth={1.5}
				/>
			</button>
		);
	});
}

function ExpandedKeyframeLanes({
	rows,
	keyframes,
	trackId,
	clipId,
	displayedStartTime,
	zoomLevel,
	clipLeft,
	keyframeDragState,
	onKeyframeMouseDown,
	onKeyframeClick,
	getVisualOffsetPx,
	containerRef,
	onLaneMouseDown,
	onLaneClick,
	selectionBox,
	isBoxSelecting,
}: {
	rows: ExpandedRow[];
	keyframes: ClipKeyframe[];
	trackId: string;
	clipId: string;
	displayedStartTime: MediaTime;
	zoomLevel: number;
	clipLeft: number;
	keyframeDragState: KeyframeDragState;
	onKeyframeMouseDown: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
	}) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onLaneMouseDown: (event: React.MouseEvent) => void;
	onLaneClick: (event: React.MouseEvent) => void;
	selectionBox: {
		bounds: SelectionBoxBounds;
	} | null;
	isBoxSelecting: boolean;
	onKeyframeClick: (params: {
		event: React.MouseEvent;
		keyframes: SelectedKeyframeRef[];
		orderedKeyframes: SelectedKeyframeRef[];
		indicatorTime: MediaTime;
	}) => void;
	getVisualOffsetPx: (params: {
		indicatorTime: MediaTime;
		indicatorOffsetPx: number;
		isBeingDragged: boolean;
		displayedStartTime: MediaTime;
		clipLeft: number;
	}) => number;
}) {
	const { isKeyframeSelected } = useKeyframeSelection();

	const orderedKeyframes = useMemo(
		() =>
			[...keyframes]
				.sort(
					(a, b) =>
						a.time - b.time || a.propertyPath.localeCompare(b.propertyPath),
				)
				.map((kf) => ({
					trackId,
					clipId,
					propertyPath: kf.propertyPath,
					keyframeId: kf.id,
				})),
		[keyframes, trackId, clipId],
	);

	return (
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- spatial gesture surface (keyframe lanes); keyboard control over keyframes is via global timeline shortcuts, not per-clip focus.
		<div
			ref={containerRef}
			className="relative flex flex-col"
			onMouseDown={onLaneMouseDown}
			onClick={onLaneClick}
		>
			{rows.map((row) => {
				const laneKeyframes = keyframes.filter(
					(kf) => kf.propertyPath === row.propertyPath,
				);
				return (
					<div
						key={row.propertyPath}
						className={cn("relative flex items-center bg-muted/50")}
						style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
					>
						{laneKeyframes.map((kf) => {
							const keyframeRef: SelectedKeyframeRef = {
								trackId,
								clipId,
								propertyPath: row.propertyPath,
								keyframeId: kf.id,
							};
							const isBeingDragged = keyframeDragState.draggingKeyframeIds.has(
								kf.id,
							);
							const kfLeft = timelineTimeToSnappedPixels({
								time: displayedStartTime + kf.time,
								zoomLevel,
							});
							const offsetPx = kfLeft - clipLeft;
							const visualOffset = getVisualOffsetPx({
								indicatorTime: kf.time,
								indicatorOffsetPx: offsetPx,
								isBeingDragged,
								displayedStartTime,
								clipLeft,
							});
							const isSelected = isKeyframeSelected({
								keyframe: keyframeRef,
							});

							return (
								<button
									key={kf.id}
									type="button"
									className={cn(
										"pointer-events-auto absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-grab",
										isBoxSelecting && "pointer-events-none",
									)}
									style={{ left: visualOffset }}
									onMouseDown={(event) => {
										event.stopPropagation();
										onKeyframeMouseDown({
											event,
											keyframes: [keyframeRef],
										});
									}}
									onClick={(event) => {
										event.stopPropagation();
										onKeyframeClick({
											event,
											keyframes: [keyframeRef],
											orderedKeyframes,
											indicatorTime: kf.time,
										});
									}}
									aria-label="Select keyframe"
								>
									<HugeiconsIcon
										icon={KeyframeIcon}
										className={cn(
											"size-3.5 text-black mr-1",
											isSelected ? "fill-primary" : "fill-white",
										)}
										strokeWidth={1.5}
									/>
								</button>
							);
						})}
					</div>
				);
			})}
			{selectionBox && <SelectionBox bounds={selectionBox.bounds} />}
		</div>
	);
}

interface ClipContentProps {
	clip: TimelineClipType;
	track: TimelineTrack;
}

function TextClipContent({
	clip,
}: {
	clip: Extract<TimelineClipType, { type: "text" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start pl-2">
			<span className="truncate text-xs text-white">
				{typeof clip.params.content === "string" ? clip.params.content : ""}
			</span>
		</div>
	);
}

function EffectClipContent({
	clip,
}: {
	clip: Extract<TimelineClipType, { type: "effect" }>;
}) {
	return (
		<div className="flex size-full items-center justify-start gap-1 pl-2">
			<HugeiconsIcon
				icon={MagicWand05Icon}
				className="size-4 shrink-0 text-white"
			/>
			<span className="truncate text-xs text-white">{clip.name}</span>
		</div>
	);
}

function StickerClipContent({
	clip,
}: {
	clip: Extract<TimelineClipType, { type: "sticker" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={resolveStickerId({
					stickerId: clip.stickerId,
					options: { width: 20, height: 20 },
				})}
				alt={clip.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{clip.name}</span>
		</div>
	);
}

function GraphicClipContent({
	clip,
}: {
	clip: Extract<TimelineClipType, { type: "graphic" }>;
}) {
	return (
		<div className="flex size-full items-center gap-2 pl-2">
			<Image
				src={buildGraphicPreviewUrl({
					definitionId: clip.definitionId,
					params: clip.params,
					size: 20,
				})}
				alt={clip.name}
				className="size-4 shrink-0"
				width={20}
				height={20}
				unoptimized
			/>
			<span className="truncate text-xs text-white">{clip.name}</span>
		</div>
	);
}

function AudioClipContent({
	clip,
	trackId,
}: {
	clip: AudioClip;
	trackId: string;
}) {
	const pixelsPerSecond = useContext(PixelsPerSecondContext);
	if (pixelsPerSecond === null) {
		throw new Error(
			"AudioClipContent must be rendered inside PixelsPerSecondContext.Provider",
		);
	}
	const projectItems = useEditor((e) => e.media.getProjectItems());
	const projectItem =
		clip.sourceType === "upload"
			? (projectItems.find((projectItem) => projectItem.id === clip.mediaId) ?? null)
			: null;

	const audioBuffer =
		clip.sourceType === "library" ? clip.buffer : undefined;
	// A missing disk file has no waveform to draw.
	const playableItem = projectItem?.missing ? undefined : projectItem;
	const audioUrl =
		clip.sourceType === "library" ? clip.sourceUrl : playableItem?.url;
	const sourceFile =
		clip.sourceType === "upload" ? playableItem?.file : undefined;
	const sourceKey =
		clip.sourceType === "upload"
			? buildWaveformSourceKey({ kind: "media", id: clip.mediaId })
			: buildWaveformSourceKey({ kind: "library", id: clip.sourceUrl });
	const mediaLabel = projectItem?.name ?? clip.name;
	const gainSamples = useMemo(
		() =>
			buildWaveformGainSamples({
				clip,
				count: WAVEFORM_GAIN_SAMPLE_COUNT,
			}),
		[clip],
	);
	if (audioBuffer || audioUrl || sourceFile) {
		return (
			<div className="group/audio relative size-full">
				<MediaClipHeader name={mediaLabel} hasFade={false} />
				<div className="absolute inset-x-0 top-5 bottom-0 overflow-hidden">
					<AudioWaveform
						sourceKey={sourceKey}
						sourceFile={sourceFile}
						audioBuffer={audioBuffer}
						audioUrl={audioUrl}
						gainSamples={gainSamples}
						pixelsPerSecond={pixelsPerSecond}
						clipDurationSec={clip.duration / TICKS_PER_SECOND}
						retime={clip.retime}
						sourceStartSec={clip.trimStart / TICKS_PER_SECOND}
						color={TIMELINE_TRACK_THEME.audio.waveformColor}
					/>
					<AudioVolumeLine clip={clip} trackId={trackId} />
				</div>
			</div>
		);
	}

	return (
		<div className="group/audio relative size-full">
			<div className="flex size-full items-center pl-2">
				<span className="text-foreground/80 truncate text-xs">
					{clip.name}
				</span>
			</div>
			<AudioVolumeLine clip={clip} trackId={trackId} />
		</div>
	);
}

function EffectsButton({
	clip,
	track,
}: {
	clip: VideoClip | ImageClip;
	track: TimelineTrack;
}) {
	const editor = useEditor();
	const setActiveTab = usePropertiesStore((s) => s.setActiveTab);

	const handleClick = (event: React.MouseEvent) => {
		event.stopPropagation();
		editor.selection.setSelectedClips({
			clips: [{ trackId: track.id, clipId: clip.id }],
		});
		setActiveTab({ clipType: clip.type, tabId: "effects" });
	};

	return (
		<button
			type="button"
			className="flex shrink-0 justify-center text-white cursor-pointer"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={handleClick}
		>
			<HugeiconsIcon icon={MagicWand05Icon} size={12} />
		</button>
	);
}

function TiledMediaContent({
	clip,
	track,
}: {
	clip: VideoClip | ImageClip;
	track: TimelineTrack;
}) {
	const projectItems = useEditor((e) => e.media.getProjectItems());

	const projectItem = projectItems.find((projectItem) => projectItem.id === clip.mediaId);
	const imageUrl =
		clip.type === "video"
			? projectItem?.thumbnailUrl
			: (projectItem?.thumbnailUrl ?? projectItem?.url);

	if (!imageUrl) {
		return (
			<span className="text-foreground/80 truncate text-xs">
				{clip.name}
			</span>
		);
	}

	const trackHeight = getTrackHeight({ type: track.type });
	const tileWidth = trackHeight * THUMBNAIL_ASPECT_RATIO;

	return (
		<>
			<div
				className="absolute inset-0"
				style={{
					backgroundColor: "var(--muted)",
					backgroundImage: `url(${imageUrl})`,
					backgroundRepeat: "repeat-x",
					backgroundSize: `${tileWidth}px ${trackHeight}px`,
					backgroundPosition: "left center",
					pointerEvents: "none",
				}}
			/>
			<MediaClipHeader
				name={projectItem?.name}
				leading={
					hasClipEffects({ clip }) ? (
						<EffectsButton clip={clip} track={track} />
					) : null
				}
				hasFade={true}
			/>
		</>
	);
}

function MediaClipHeader({
	name,
	leading,
	hasFade,
}: {
	name?: string | null;
	leading?: ReactNode;
	hasFade?: boolean;
}) {
	if (!name && !leading) {
		return null;
	}

	return (
		<div
			className={cn(
				"absolute top-0 left-0 flex h-5 w-full bg-linear-to-b pt-1",
				hasFade && "from-black/30 to-transparent",
			)}
		>
			{leading && <div className="pl-1">{leading}</div>}
			{name && (
				<span className="truncate px-1.5 text-[0.6rem] leading-tight text-white/75">
					{name}
				</span>
			)}
		</div>
	);
}

function ClipContent({ clip, track }: ClipContentProps) {
	switch (clip.type) {
		case "text":
			return <TextClipContent clip={clip} />;
		case "effect":
			return <EffectClipContent clip={clip} />;
		case "sticker":
			return <StickerClipContent clip={clip} />;
		case "graphic":
			return <GraphicClipContent clip={clip} />;
		case "audio":
			return <AudioClipContent clip={clip} trackId={track.id} />;
		case "video":
		case "image":
			return <TiledMediaContent clip={clip} track={track} />;
	}
}

function CopyMenuItem() {
	return (
		<ActionMenuItem
			action="copy-selected"
			icon={<HugeiconsIcon icon={Copy01Icon} />}
		>
			Copy
		</ActionMenuItem>
	);
}

function MuteMenuItem({
	isMultipleSelected,
	isCurrentClipSelected,
	isMuted,
}: {
	isMultipleSelected: boolean;
	isCurrentClipSelected: boolean;
	isMuted: boolean;
}) {
	const getIcon = () => {
		if (isMultipleSelected && isCurrentClipSelected) {
			return <HugeiconsIcon icon={VolumeMute02Icon} />;
		}
		return isMuted ? (
			<HugeiconsIcon icon={VolumeOffIcon} />
		) : (
			<HugeiconsIcon icon={VolumeHighIcon} />
		);
	};

	return (
		<ActionMenuItem action="toggle-clips-muted-selected" icon={getIcon()}>
			{isMuted ? "Unmute" : "Mute"}
		</ActionMenuItem>
	);
}

function VisibilityMenuItem({
	clip,
	isMultipleSelected,
	isCurrentClipSelected,
}: {
	clip: TimelineClipType;
	isMultipleSelected: boolean;
	isCurrentClipSelected: boolean;
}) {
	const isHidden = canClipBeHidden(clip) && clip.hidden;

	const getIcon = () => {
		if (isMultipleSelected && isCurrentClipSelected) {
			return <HugeiconsIcon icon={ViewOffSlashIcon} />;
		}
		return isHidden ? (
			<HugeiconsIcon icon={ViewIcon} />
		) : (
			<HugeiconsIcon icon={ViewOffSlashIcon} />
		);
	};

	return (
		<ActionMenuItem
			action="toggle-clips-visibility-selected"
			icon={getIcon()}
		>
			{isHidden ? "Show" : "Hide"}
		</ActionMenuItem>
	);
}

function DeleteMenuItem({
	isMultipleSelected,
	isCurrentClipSelected,
	clipType,
	selectedCount,
}: {
	isMultipleSelected: boolean;
	isCurrentClipSelected: boolean;
	clipType: TimelineClipType["type"];
	selectedCount: number;
}) {
	return (
		<ActionMenuItem
			action="delete-selected"
			variant="destructive"
			icon={<HugeiconsIcon icon={Delete02Icon} />}
		>
			{isMultipleSelected && isCurrentClipSelected
				? `Delete ${selectedCount} clips`
				: `Delete ${clipType === "text" ? "text" : "clip"}`}
		</ActionMenuItem>
	);
}

function ActionMenuItem({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof ContextMenuItem>, "onClick" | "textRight"> & {
	action: TActionWithOptionalArgs;
	children: ReactNode;
}) {
	return (
		<ContextMenuItem
			onClick={(event: React.MouseEvent) => {
				event.stopPropagation();
				invokeAction(action);
			}}
			textRight={getDisplayShortcut({ action })}
			{...props}
		>
			{children}
		</ContextMenuItem>
	);
}
