import type { DragEvent } from "react";
import { processProjectItems } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import {
	DEFAULT_NEW_CLIP_DURATION,
	toClipDurationTicks,
} from "@/timeline/creation";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import type { FrameRate } from "opencut-wasm";
import {
	buildTextClip,
	buildGraphicClip,
	buildStickerClip,
	buildClipFromMedia,
	buildEffectClip,
} from "@/timeline/clip-utils";
import { AddTrackCommand, InsertClipCommand } from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import type { Command } from "@/commands/base-command";
import { computeDropTarget } from "@/timeline/components/drop-target";
import type { TimelineDragSource } from "@/timeline/drag-source";
import type {
	TrackType,
	DropTarget,
	ClipType,
	SequenceTracks,
	TimelineTrack,
	CreateTimelineClip,
} from "@/timeline";
import type { TimelineDragData } from "@/timeline/drag";
import type { ProjectItem } from "@/media/types";
import type { ProcessedProjectItem } from "@/media/processing";
import { roundFrameTime, type MediaTime } from "@/wasm";

// --- Config ---

export interface DragDropConfig {
	zoomLevel: number;
	getContainerEl: () => HTMLDivElement | null;
	getHeaderEl: () => HTMLElement | null;
	getTracksScrollEl: () => HTMLDivElement | null;
	getActiveProjectFps: () => FrameRate | null;
	getActiveProjectId: () => string | null;
	getSequenceTracks: () => SequenceTracks;
	getCurrentPlayheadTime: () => MediaTime;
	getProjectItems: () => ProjectItem[];
	dragSource: TimelineDragSource;
	addProjectItem: (args: {
		projectId: string;
		projectItem: ProcessedProjectItem;
	}) => Promise<ProjectItem | null>;
	executeCommand: (command: Command) => void;
	insertClip: (args: {
		placement: { mode: "explicit"; trackId: string };
		clip: CreateTimelineClip;
	}) => void;
	addClipEffect: (args: {
		trackId: string;
		clipId: string;
		effectType: string;
	}) => void;
}

export interface DragDropConfigRef {
	readonly current: DragDropConfig;
}

// --- State ---

interface DragOverState {
	kind: "over";
	dropTarget: DropTarget | null;
	clipType: ClipType | null;
}

type DragDropState = { kind: "idle" } | DragOverState;

interface TimelineCoords {
	mouseX: number;
	mouseY: number;
}

// --- Pure helpers ---

function clipTypeFromDrag({
	dragData,
}: {
	dragData: TimelineDragData;
}): ClipType {
	switch (dragData.type) {
		case "text":
			return "text";
		case "graphic":
			return "graphic";
		case "sticker":
			return "sticker";
		case "effect":
			return "effect";
		case "media":
			return dragData.mediaType;
	}
}

function getTargetClipTypesForDrag({
	dragData,
}: {
	dragData: TimelineDragData;
}): string[] | undefined {
	if (dragData.type === "effect") return dragData.targetClipTypes;
	if (dragData.type === "media") return dragData.targetClipTypes;
	return undefined;
}

function getDurationForDrag({
	dragData,
	projectItems,
}: {
	dragData: TimelineDragData;
	projectItems: ProjectItem[];
}): MediaTime {
	if (dragData.type !== "media") return DEFAULT_NEW_CLIP_DURATION;
	const media = projectItems.find((projectItem) => projectItem.id === dragData.id);
	return toClipDurationTicks({ seconds: media?.duration });
}

function orderedTracks({
	sequenceTracks,
}: {
	sequenceTracks: SequenceTracks;
}): TimelineTrack[] {
	return [...sequenceTracks.overlay, sequenceTracks.main, ...sequenceTracks.audio];
}

// --- Controller ---

export class DragDropController {
	private state: DragDropState = { kind: "idle" };
	private enterCount = 0;
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: DragDropConfigRef;

	constructor(deps: { configRef: DragDropConfigRef }) {
		this.configRef = deps.configRef;
		this.onDragEnter = this.onDragEnter.bind(this);
		this.onDragOver = this.onDragOver.bind(this);
		this.onDragLeave = this.onDragLeave.bind(this);
		this.onDrop = this.onDrop.bind(this);
	}

	private get config(): DragDropConfig {
		return this.configRef.current;
	}

	get isDragOver(): boolean {
		return this.state.kind !== "idle";
	}

	get dropTarget(): DropTarget | null {
		return this.state.kind === "over" ? this.state.dropTarget : null;
	}

	get dragClipType(): ClipType | null {
		return this.state.kind === "over" ? this.state.clipType : null;
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	destroy(): void {
		this.subscribers.clear();
	}

	// --- Drag event handlers (bound, stable, passed as React props) ---

	onDragEnter(event: DragEvent): void {
		event.preventDefault();
		const hasProjectItem = this.config.dragSource.isActive();
		const hasFiles = event.dataTransfer.types.includes("Files");
		if (!hasProjectItem && !hasFiles) return;

		this.enterCount += 1;
		if (this.state.kind === "idle") {
			this.setOver({ dropTarget: null, clipType: null });
		}
	}

	onDragOver(event: DragEvent): void {
		event.preventDefault();

		const coords = this.getMouseTimelineCoords({ event });
		if (!coords) return;

		const dragData = this.config.dragSource.getActive();
		const hasFiles = event.dataTransfer.types.includes("Files");
		const isExternal = hasFiles && !dragData;

		if (!dragData) {
			if (hasFiles && isExternal) {
				this.setOver({ dropTarget: null, clipType: null });
			}
			return;
		}

		const clipType = clipTypeFromDrag({ dragData });
		const duration = getDurationForDrag({
			dragData,
			projectItems: this.config.getProjectItems(),
		});
		const targetClipTypes = getTargetClipTypesForDrag({ dragData });

		const sequenceTracks = this.config.getSequenceTracks();
		const target = computeDropTarget({
			clipType,
			mouseX: coords.mouseX,
			mouseY: coords.mouseY,
			tracks: sequenceTracks,
			playheadTime: this.config.getCurrentPlayheadTime(),
			isExternalDrop: isExternal,
			clipDuration: duration,
			pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
			zoomLevel: this.config.zoomLevel,
			targetClipTypes,
		});

		const fps = this.config.getActiveProjectFps();
		target.xPosition = fps
			? roundFrameTime({ time: target.xPosition, fps })
			: target.xPosition;

		this.setOver({ dropTarget: target, clipType });
		event.dataTransfer.dropEffect = "copy";
	}

	onDragLeave(event: DragEvent): void {
		event.preventDefault();
		if (this.enterCount === 0) return;
		this.enterCount -= 1;
		if (this.enterCount === 0) {
			this.setIdle();
		}
	}

	onDrop(event: DragEvent): void {
		event.preventDefault();
		this.enterCount = 0;

		const dragData = this.config.dragSource.getActive();
		const hasFiles = event.dataTransfer.files?.length > 0;
		if (!dragData && !hasFiles) return;

		const currentTarget = this.dropTarget;
		this.setIdle();

		try {
			if (dragData) {
				if (!currentTarget) return;
				this.executeProjectItemDrop({ target: currentTarget, dragData });
				return;
			}

			const coords = this.getMouseTimelineCoords({ event });
			if (!coords) return;
			this.executeFileDrop({
				files: Array.from(event.dataTransfer.files),
				mouseX: coords.mouseX,
				mouseY: coords.mouseY,
			}).catch((error) => {
				console.error("Failed to process file drop:", error);
			});
		} catch (error) {
			console.error("Failed to process drop:", error);
		}
	}

	// --- Private ---

	private setOver(state: {
		dropTarget: DropTarget | null;
		clipType: ClipType | null;
	}): void {
		this.state = { kind: "over", ...state };
		this.notify();
	}

	private setIdle(): void {
		this.state = { kind: "idle" };
		this.notify();
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private getMouseTimelineCoords({
		event,
	}: {
		event: DragEvent;
	}): TimelineCoords | null {
		const scrollContainer = this.config.getTracksScrollEl();
		const referenceRect =
			scrollContainer?.getBoundingClientRect() ??
			this.config.getContainerEl()?.getBoundingClientRect();
		if (!referenceRect) return null;

		const scrollLeft = scrollContainer?.scrollLeft ?? 0;
		const scrollTop = scrollContainer?.scrollTop ?? 0;
		const headerHeight =
			this.config.getHeaderEl()?.getBoundingClientRect().height ?? 0;

		return {
			mouseX: event.clientX - referenceRect.left + scrollLeft,
			mouseY: event.clientY - referenceRect.top + scrollTop - headerHeight,
		};
	}

	// Shared insertion logic — new track vs existing track.
	private insertAtTarget({
		clip,
		target,
		trackType,
	}: {
		clip: CreateTimelineClip;
		target: DropTarget;
		trackType: TrackType;
	}): void {
		if (target.isNewTrack) {
			const addTrackCmd = new AddTrackCommand({
				type: trackType,
				index: target.trackIndex,
			});
			this.config.executeCommand(
				new BatchCommand([
					addTrackCmd,
					new InsertClipCommand({
						clip,
						placement: { mode: "explicit", trackId: addTrackCmd.getTrackId() },
					}),
				]),
			);
			return;
		}

		const tracks = orderedTracks({ sequenceTracks: this.config.getSequenceTracks() });
		const track = tracks[target.trackIndex];
		if (!track) return;
		this.config.insertClip({
			placement: { mode: "explicit", trackId: track.id },
			clip,
		});
	}

	private executeProjectItemDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: TimelineDragData;
	}): void {
		switch (dragData.type) {
			case "text":
				this.executeTextDrop({ target, dragData });
				return;
			case "graphic":
				this.executeGraphicDrop({ target, dragData });
				return;
			case "sticker":
				this.executeStickerDrop({ target, dragData });
				return;
			case "effect":
				this.executeEffectDrop({ target, dragData });
				return;
			case "media":
				this.executeMediaDrop({ target, dragData });
				return;
		}
	}

	private executeTextDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "text" }>;
	}): void {
		const clip = buildTextClip({
			raw: {
				name: dragData.name ?? "",
				params: { content: dragData.content ?? "" },
			},
			startTime: target.xPosition,
		});
		this.insertAtTarget({ clip, target, trackType: "text" });
	}

	private executeStickerDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "sticker" }>;
	}): void {
		const clip = buildStickerClip({
			stickerId: dragData.stickerId,
			name: dragData.name,
			startTime: target.xPosition,
		});
		this.insertAtTarget({ clip, target, trackType: "graphic" });
	}

	private executeGraphicDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "graphic" }>;
	}): void {
		const clip = buildGraphicClip({
			definitionId: dragData.definitionId,
			name: dragData.name,
			startTime: target.xPosition,
			params: dragData.params,
		});
		this.insertAtTarget({ clip, target, trackType: "graphic" });
	}

	private executeMediaDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "media" }>;
	}): void {
		if (target.targetClip) {
			// Replace media source — not yet implemented
			return;
		}

		const projectItem = this.config
			.getProjectItems()
			.find((projectItem) => projectItem.id === dragData.id);
		if (!projectItem) return;

		const trackType: TrackType =
			dragData.mediaType === "audio" ? "audio" : "video";
		const clip = buildClipFromMedia({
			mediaId: projectItem.id,
			mediaType: projectItem.type,
			name: projectItem.name,
			duration: toClipDurationTicks({ seconds: projectItem.duration }),
			startTime: target.xPosition,
		});
		this.insertAtTarget({ clip, target, trackType });
	}

	private executeEffectDrop({
		target,
		dragData,
	}: {
		target: DropTarget;
		dragData: Extract<TimelineDragData, { type: "effect" }>;
	}): void {
		if (target.targetClip) {
			this.config.addClipEffect({
				trackId: target.targetClip.trackId,
				clipId: target.targetClip.clipId,
				effectType: dragData.effectType,
			});
			return;
		}

		const clip = buildEffectClip({
			effectType: dragData.effectType,
			startTime: target.xPosition,
		});

		const existingEffectTrack = orderedTracks({
			sequenceTracks: this.config.getSequenceTracks(),
		}).find((track) => track.type === "effect");

		if (existingEffectTrack) {
			this.config.insertClip({
				placement: { mode: "explicit", trackId: existingEffectTrack.id },
				clip,
			});
			return;
		}

		this.insertAtTarget({ clip, target, trackType: "effect" });
	}

	private async executeFileDrop({
		files,
		mouseX,
		mouseY,
	}: {
		files: File[];
		mouseX: number;
		mouseY: number;
	}): Promise<void> {
		const projectId = this.config.getActiveProjectId();
		if (!projectId) return;

		await showMediaUploadToast({
			filesCount: files.length,
			promise: async () => {
				const processedProjectItems = await processProjectItems({ files });

				// Sequential on purpose: each iteration reads getSequenceTracks()
				// to decide placement (reuse empty main vs new track) and that
				// decision depends on the effects of prior inserts.
				for (const projectItem of processedProjectItems) {
					const createdProjectItem = await this.config.addProjectItem({
						projectId,
						projectItem,
					});
					if (!createdProjectItem) continue;

					const duration = toClipDurationTicks({
						seconds: createdProjectItem.duration,
					});

					const sequenceTracks = this.config.getSequenceTracks();
					const currentTime = this.config.getCurrentPlayheadTime();

					const reuseMainTrackId =
						createdProjectItem.type !== "audio" &&
						sequenceTracks.overlay.length === 0 &&
						sequenceTracks.audio.length === 0 &&
						sequenceTracks.main.clips.length === 0
							? sequenceTracks.main.id
							: null;

					if (reuseMainTrackId) {
						this.config.insertClip({
							placement: { mode: "explicit", trackId: reuseMainTrackId },
							clip: buildClipFromMedia({
								mediaId: createdProjectItem.id,
								mediaType: createdProjectItem.type,
								name: createdProjectItem.name,
								duration,
								startTime: currentTime,
							}),
						});
						continue;
					}

					const dropTarget = computeDropTarget({
						clipType: createdProjectItem.type,
						mouseX,
						mouseY,
						tracks: sequenceTracks,
						playheadTime: currentTime,
						isExternalDrop: true,
						clipDuration: duration,
						pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
						zoomLevel: this.config.zoomLevel,
					});

					const trackType: TrackType =
						createdProjectItem.type === "audio" ? "audio" : "video";
					this.insertAtTarget({
						clip: buildClipFromMedia({
							mediaId: createdProjectItem.id,
							mediaType: createdProjectItem.type,
							name: createdProjectItem.name,
							duration,
							startTime: dropTarget.xPosition,
						}),
						target: dropTarget,
						trackType,
					});
				}

				return {
					uploadedCount: processedProjectItems.length,
					projectItemNames: processedProjectItems.map((projectItem) => projectItem.name),
				};
			},
		});
	}
}
