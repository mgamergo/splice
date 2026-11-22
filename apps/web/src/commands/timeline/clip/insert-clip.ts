import { Command, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type {
	CreateTimelineClip,
	SequenceTracks,
	TimelineClip,
	TrackType,
} from "@/timeline";
import { generateUUID } from "@/utils/id";
import { requiresMediaId } from "@/timeline/clip-utils";
import type { ProjectItem } from "@/media/types";
import { DEFAULT_NEW_CLIP_DURATION } from "@/timeline/creation";
import { floatToFrameRate } from "@/fps/utils";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import {
	applyPlacement,
	canClipGoOnTrack,
	resolveTrackPlacement,
	validateClipTrackCompatibility,
} from "@/timeline/placement";
import { roundMediaTime } from "@/wasm";

type InsertClipPlacement =
	| { mode: "explicit"; trackId: string }
	| { mode: "auto"; trackType?: TrackType; insertIndex?: number };

export interface InsertClipParams {
	clip: CreateTimelineClip;
	placement: InsertClipPlacement;
}

export class InsertClipCommand extends Command {
	private clipId: string;
	private savedState: SequenceTracks | null = null;
	private targetTrackId: string | null = null;

	constructor({ clip, placement }: InsertClipParams) {
		super();
		this.clipId = generateUUID();
		this.clip = clip;
		this.placement = placement;
	}

	private clip: CreateTimelineClip;
	private placement: InsertClipPlacement;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		if (!this.validateClipBasics({ clip: this.clip })) {
			return;
		}

		const totalClipsInTimeline =
			this.savedState.main.clips.length +
			this.savedState.overlay.reduce(
				(total, track) => total + track.clips.length,
				0,
			) +
			this.savedState.audio.reduce(
				(total, track) => total + track.clips.length,
				0,
			);
		const isFirstClip = totalClipsInTimeline === 0;

		const newClip = this.buildClip({ clip: this.clip });
		const updateResult = this.applyPlacementResult({
			tracks: this.savedState,
			clip: newClip,
		});

		if (!updateResult) {
			return;
		}

		const { updatedTracks, targetTrackId } = updateResult;
		this.targetTrackId = targetTrackId;

		const isVisualMedia =
			newClip.type === "video" || newClip.type === "image";

		if (isFirstClip && isVisualMedia) {
			const projectItems = editor.media.getProjectItems();
			const activeProject = editor.project.getActive();
			const projectItem = projectItems.find(
				(item: ProjectItem) => item.id === newClip.mediaId,
			);

			if (projectItem?.width && projectItem?.height) {
				const nextCanvasSize = { width: projectItem.width, height: projectItem.height };
				const shouldSetOriginalCanvasSize =
					!activeProject?.settings.originalCanvasSize;
				editor.project.updateSettings({
					settings: {
						canvasSize: nextCanvasSize,
						...(shouldSetOriginalCanvasSize
							? { originalCanvasSize: nextCanvasSize }
							: {}),
					},
					pushHistory: false,
				});
			}

			if (projectItem?.type === "video" && projectItem?.fps) {
				editor.project.updateSettings({
					settings: { fps: floatToFrameRate(projectItem.fps) },
					pushHistory: false,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedClips: [
					{ trackId: targetTrackId, clipId: this.clipId },
				],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getClipId(): string {
		return this.clipId;
	}

	getTrackId(): string | null {
		return this.targetTrackId;
	}

	private buildClip({
		clip,
	}: {
		clip: CreateTimelineClip;
	}): TimelineClip {
		return {
			...clip,
			id: this.clipId,
			startTime: clip.startTime,
			trimStart: clip.trimStart ?? 0,
			trimEnd: clip.trimEnd ?? 0,
			duration: clip.duration ?? DEFAULT_NEW_CLIP_DURATION,
		} as TimelineClip;
	}

	private validateClipBasics({
		clip,
	}: {
		clip: CreateTimelineClip;
	}): boolean {
		if (requiresMediaId({ clip }) && !("mediaId" in clip)) {
			console.error("Element requires mediaId");
			return false;
		}

		if (
			clip.type === "audio" &&
			clip.sourceType === "library" &&
			!clip.sourceUrl
		) {
			console.error("Library audio clip must have sourceUrl");
			return false;
		}

		if (clip.type === "sticker" && !clip.stickerId) {
			console.error("Sticker clip must have stickerId");
			return false;
		}

		if (clip.type === "graphic") {
			registerDefaultGraphics();
			if (
				!clip.definitionId ||
				!graphicsRegistry.has(clip.definitionId)
			) {
				console.error("Graphic clip must have a valid definitionId");
				return false;
			}
		}

		if (clip.type === "text" && !clip.params.content) {
			console.error("Text clip must have content");
			return false;
		}

		if (clip.type === "effect" && !clip.effectType) {
			console.error("Effect clip must have effectType");
			return false;
		}

		return true;
	}

	private applyPlacementResult({
		tracks,
		clip,
	}: {
		tracks: SequenceTracks;
		clip: TimelineClip;
	}): { updatedTracks: SequenceTracks; targetTrackId: string } | null {
		const placement = this.placement;

		if (
			placement.mode === "auto" &&
			placement.trackType &&
			!canClipGoOnTrack({
				clipType: clip.type,
				trackType: placement.trackType,
			})
		) {
			console.error(
				`${clip.type} clips cannot be placed on ${placement.trackType} tracks`,
			);
			return null;
		}

		const placementResult = resolveTrackPlacement({
			tracks,
			...(placement.mode === "auto" && placement.trackType
				? { trackType: placement.trackType }
				: { clipType: clip.type }),
			timeSpans: [
				{
					startTime: clip.startTime,
					duration: clip.duration,
				},
			],
			strategy:
				placement.mode === "explicit"
					? { type: "explicit", trackId: placement.trackId }
					: { type: "firstAvailable" },
		});
		if (!placementResult) {
			if (placement.mode === "explicit") {
				const targetTrack =
					tracks.main.id === placement.trackId
						? tracks.main
						: (tracks.overlay.find((track) => track.id === placement.trackId) ??
							tracks.audio.find((track) => track.id === placement.trackId));
				if (!targetTrack) {
					console.error("Track not found:", placement.trackId);
					return null;
				}

				const validation = validateClipTrackCompatibility({
					clip,
					track: targetTrack,
				});
				console.error(validation.errorMessage);
			}

			return null;
		}

		const clipToPlace =
			placementResult.kind === "existingTrack"
				? {
						...clip,
						startTime:
							placementResult.adjustedStartTime !== undefined
								? roundMediaTime({
										time: placementResult.adjustedStartTime,
									})
								: clip.startTime,
					}
				: clip;

		const appliedPlacement = applyPlacement({
			tracks,
			placementResult,
			clips: [clipToPlace],
			newTrackInsertIndexOverride:
				placement.mode === "auto" && typeof placement.insertIndex === "number"
					? placement.insertIndex
					: undefined,
		});
		if (!appliedPlacement) {
			return null;
		}

		return {
			updatedTracks: appliedPlacement.updatedTracks,
			targetTrackId: appliedPlacement.targetTrackId,
		};
	}
}
