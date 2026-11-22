import type { EditorCore } from "@/core";
import type { ClipBounds } from "@/preview/clip-bounds";
import type { ParamValues } from "@/params";
import type {
	SequenceTracks,
	TrackType,
	TimelineTrack,
	TimelineClip,
	RetimeConfig,
} from "@/timeline";
import { calculateTotalDuration } from "@/timeline";
import { TimelineDragSource } from "@/timeline/drag-source";
import { findTrackInSequenceTracks } from "@/timeline/track-clip-update";
import { lastFrameMediaTime, type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import {
	canClipBeHidden,
	canClipHaveAudio,
} from "@/timeline/clip-utils";
import { isClipMuted } from "@/timeline/audio-state";
import type {
	AnimationPath,
	AnimationInterpolation,
	ScalarCurveKeyframePatch,
} from "@/animation/types";
import type { ParamValue } from "@/params";
import {
	getClipLocalTime,
	resolveAnimationPathValueAtTime,
} from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { BatchCommand } from "@/commands";
import {
	AddTrackCommand,
	RemoveTrackCommand,
	ToggleTrackMuteCommand,
	ToggleTrackVisibilityCommand,
	InsertClipCommand,
	DeleteClipsCommand,
	DuplicateClipsCommand,
	UpdateClipsCommand,
	RazorClipsCommand,
	MoveClipCommand,
	TracksSnapshotCommand,
	UpsertKeyframeCommand,
	RemoveKeyframeCommand,
	RetimeKeyframeCommand,
	UpdateScalarKeyframeCurveCommand,
	AddClipEffectCommand,
	DeleteFreeformPathMaskPointsCommand,
	InsertFreeformPathMaskPointCommand,
	RemoveClipEffectCommand,
	UpdateClipEffectParamsCommand,
	ToggleClipEffectCommand,
	ReorderClipEffectsCommand,
	RemoveMaskCommand,
	ToggleMaskInvertedCommand,
	UpsertEffectParamKeyframeCommand,
	RemoveEffectParamKeyframeCommand,
	ToggleSourceAudioSeparationCommand,
} from "@/commands/timeline";
import type { InsertClipParams } from "@/commands/timeline/clip/insert-clip";
import type {
	PlannedClipMove,
	PlannedTrackCreation,
} from "@/timeline/group-move";

export class TimelineManager {
	private listeners = new Set<() => void>();
	private previewOverlay = new Map<string, Partial<TimelineClip>>();
	private previewTracks: SequenceTracks | null = null;
	public readonly dragSource = new TimelineDragSource();

	constructor(private editor: EditorCore) {}

	addTrack({ type, index }: { type: TrackType; index?: number }): string {
		const command = new AddTrackCommand({ type, index });
		this.editor.command.execute({ command });
		return command.getTrackId();
	}

	removeTrack({ trackId }: { trackId: string }): void {
		const command = new RemoveTrackCommand(trackId);
		this.editor.command.execute({ command });
	}

	insertClip({ clip, placement }: InsertClipParams): void {
		const command = new InsertClipCommand({ clip, placement });
		this.editor.command.execute({ command });
	}

	updateClipTrim({
		clipId,
		trimStart,
		trimEnd,
		startTime,
		duration,
		pushHistory = true,
	}: {
		clipId: string;
		trimStart: MediaTime;
		trimEnd: MediaTime;
		startTime?: MediaTime;
		duration?: MediaTime;
		pushHistory?: boolean;
	}): void {
		const trackId = this.findTrackIdForClip({ clipId });
		if (!trackId) {
			return;
		}

		const nextUpdates: Partial<TimelineClip> = {
			trimStart,
			trimEnd,
		};
		if (startTime !== undefined) {
			nextUpdates.startTime = startTime;
		}
		if (duration !== undefined) {
			nextUpdates.duration = duration;
		}

		this.updateClips({
			updates: [
				{
					trackId,
					clipId,
					patch: nextUpdates,
				},
			],
			pushHistory,
		});
	}

	updateClipRetime({
		trackId,
		clipId,
		retime,
		pushHistory = true,
	}: {
		trackId: string;
		clipId: string;
		retime?: RetimeConfig;
		pushHistory?: boolean;
	}): void {
		this.updateClips({
			updates: [
				{
					trackId,
					clipId,
					patch: {
						retime,
					},
				},
			],
			pushHistory,
		});
	}

	moveClips({
		moves,
		createTracks,
	}: {
		moves: PlannedClipMove[];
		createTracks?: PlannedTrackCreation[];
	}): void {
		if (moves.length === 0) {
			return;
		}

		const command = new MoveClipCommand({
			moves,
			createTracks,
		});
		this.editor.command.execute({ command });
	}

	toggleTrackMute({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackMuteCommand(trackId);
		this.editor.command.execute({ command });
	}

	toggleTrackVisibility({ trackId }: { trackId: string }): void {
		const command = new ToggleTrackVisibilityCommand(trackId);
		this.editor.command.execute({ command });
	}

	razorClips({
		clips,
		splitTime,
		retainSide = "both",
	}: {
		clips: { trackId: string; clipId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}): { trackId: string; clipId: string }[] {
		const command = new RazorClipsCommand({
			clips,
			splitTime,
			retainSide,
		});
		this.editor.command.execute({ command });
		return command.getRightSideClips();
	}

	getTotalDuration(): MediaTime {
		const activeSequence = this.editor.sequences.getActiveSequenceOrNull();
		if (!activeSequence) {
			return ZERO_MEDIA_TIME;
		}

		return calculateTotalDuration({ tracks: activeSequence.tracks });
	}

	getLastFrameTime(): MediaTime {
		const duration = this.getTotalDuration();
		const fps = this.editor.project.getActive()?.settings.fps;
		if (!fps || duration <= 0) return duration;
		return lastFrameMediaTime({ duration, fps });
	}

	getTrackById({ trackId }: { trackId: string }): TimelineTrack | null {
		const activeSequence = this.editor.sequences.getActiveSequenceOrNull();
		if (!activeSequence) {
			return null;
		}

		return findTrackInSequenceTracks({ tracks: activeSequence.tracks, trackId });
	}

	getClipsWithTracks({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}): Array<{ track: TimelineTrack; clip: TimelineClip }> {
		const result: Array<{ track: TimelineTrack; clip: TimelineClip }> =
			[];

		for (const { trackId, clipId } of clips) {
			const track = this.getTrackById({ trackId });
			const clip = track?.clips.find(
				(trackClip) => trackClip.id === clipId,
			);

			if (track && clip) {
				result.push({ track, clip });
			}
		}

		return result;
	}

	deleteClips({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}): void {
		const command = new DeleteClipsCommand({ clips });
		this.editor.command.execute({ command });
	}

	toggleSourceAudioSeparation({
		trackId,
		clipId,
	}: {
		trackId: string;
		clipId: string;
	}): void {
		const command = new ToggleSourceAudioSeparationCommand({
			trackId,
			clipId,
		});
		this.editor.command.execute({ command });
	}

	updateClips({
		updates,
		pushHistory = true,
	}: {
		updates: Array<{
			trackId: string;
			clipId: string;
			patch: Partial<TimelineClip>;
		}>;
		pushHistory?: boolean;
	}): void {
		if (updates.length === 0) {
			return;
		}

		const command = new UpdateClipsCommand({
			updates,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	addClipEffect({
		trackId,
		clipId,
		effectType,
	}: {
		trackId: string;
		clipId: string;
		effectType: string;
	}): string {
		const command = new AddClipEffectCommand({
			trackId,
			clipId,
			effectType,
		});
		this.editor.command.execute({ command });
		return command.getEffectId() ?? "";
	}

	removeClipEffect({
		trackId,
		clipId,
		effectId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
	}): void {
		const command = new RemoveClipEffectCommand({
			trackId,
			clipId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	removeMask({
		trackId,
		clipId,
		maskId,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
	}): void {
		const command = new RemoveMaskCommand({
			trackId,
			clipId,
			maskId,
		});
		this.editor.command.execute({ command });
	}

	deleteFreeformPathMaskPoints({
		trackId,
		clipId,
		maskId,
		pointIds,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
		pointIds: string[];
	}): void {
		if (pointIds.length === 0) {
			return;
		}
		const command = new DeleteFreeformPathMaskPointsCommand({
			trackId,
			clipId,
			maskId,
			pointIds,
		});
		this.editor.command.execute({ command });
	}

	insertFreeformPathMaskPoint({
		trackId,
		clipId,
		maskId,
		segmentIndex,
		canvasPoint,
		bounds,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
		segmentIndex: number;
		canvasPoint: { x: number; y: number };
		bounds: ClipBounds;
	}): void {
		const command = new InsertFreeformPathMaskPointCommand({
			trackId,
			clipId,
			maskId,
			segmentIndex,
			canvasPoint,
			bounds,
		});
		this.editor.command.execute({ command });
	}

	updateClipEffectParams({
		trackId,
		clipId,
		effectId,
		params,
		pushHistory = true,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
		params: Partial<ParamValues>;
		pushHistory?: boolean;
	}): void {
		const command = new UpdateClipEffectParamsCommand({
			trackId,
			clipId,
			effectId,
			params,
		});
		if (pushHistory) {
			this.editor.command.execute({ command });
		} else {
			command.execute();
		}
	}

	toggleClipEffect({
		trackId,
		clipId,
		effectId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
	}): void {
		const command = new ToggleClipEffectCommand({
			trackId,
			clipId,
			effectId,
		});
		this.editor.command.execute({ command });
	}

	toggleMaskInverted({
		trackId,
		clipId,
		maskId,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
	}): void {
		const command = new ToggleMaskInvertedCommand({
			trackId,
			clipId,
			maskId,
		});
		this.editor.command.execute({ command });
	}

	reorderClipEffects({
		trackId,
		clipId,
		fromIndex,
		toIndex,
	}: {
		trackId: string;
		clipId: string;
		fromIndex: number;
		toIndex: number;
	}): void {
		const command = new ReorderClipEffectsCommand({
			trackId,
			clipId,
			fromIndex,
			toIndex,
		});
		this.editor.command.execute({ command });
	}

	upsertKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			clipId: string;
			propertyPath: AnimationPath;
			time: MediaTime;
			value: ParamValue;
			interpolation?: AnimationInterpolation;
			keyframeId?: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({
				trackId,
				clipId,
				propertyPath,
				time,
				value,
				interpolation,
				keyframeId,
			}) =>
				new UpsertKeyframeCommand({
					trackId,
					clipId,
					propertyPath,
					time,
					value,
					interpolation,
					keyframeId,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	removeKeyframes({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			clipId: string;
			propertyPath: AnimationPath;
			keyframeId: string;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		// Pre-sample values at playhead for each (clip, property) pair.
		// This preserves "what you see is what you get" when all keyframes are deleted.
		const playheadTime = this.editor.playback.getCurrentTime();
		const valueAtPlayheadMap = new Map<string, ParamValue | null>();

		for (const { trackId, clipId, propertyPath } of keyframes) {
			const key = `${clipId}:${propertyPath}`;
			if (valueAtPlayheadMap.has(key)) {
				continue;
			}

			const clip = this.getClipByRef({ trackId, clipId });
			if (!clip) {
				valueAtPlayheadMap.set(key, null);
				continue;
			}

			const localTime = getClipLocalTime({
				timelineTime: playheadTime,
				clipStartTime: clip.startTime,
				clipDuration: clip.duration,
			});

			const target = resolveAnimationTarget({ clip, path: propertyPath });
			const baseValue = target?.getBaseValue() ?? null;
			if (baseValue === null) {
				valueAtPlayheadMap.set(key, null);
				continue;
			}

			const value = resolveAnimationPathValueAtTime({
				animations: clip.animations,
				propertyPath,
				localTime,
				fallbackValue: baseValue,
			});
			valueAtPlayheadMap.set(key, value);
		}

		const commands = keyframes.map(
			({ trackId, clipId, propertyPath, keyframeId }) =>
				new RemoveKeyframeCommand({
					trackId,
					clipId,
					propertyPath,
					keyframeId,
					valueAtPlayhead:
						valueAtPlayheadMap.get(`${clipId}:${propertyPath}`) ?? null,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	retimeKeyframe({
		trackId,
		clipId,
		propertyPath,
		keyframeId,
		time,
	}: {
		trackId: string;
		clipId: string;
		propertyPath: AnimationPath;
		keyframeId: string;
		time: MediaTime;
	}): void {
		const command = new RetimeKeyframeCommand({
			trackId,
			clipId,
			propertyPath,
			keyframeId,
			nextTime: time,
		});
		this.editor.command.execute({ command });
	}

	updateKeyframeCurves({
		keyframes,
	}: {
		keyframes: Array<{
			trackId: string;
			clipId: string;
			propertyPath: AnimationPath;
			componentKey: string;
			keyframeId: string;
			patch: ScalarCurveKeyframePatch;
		}>;
	}): void {
		if (keyframes.length === 0) {
			return;
		}

		const commands = keyframes.map(
			({ trackId, clipId, propertyPath, componentKey, keyframeId, patch }) =>
				new UpdateScalarKeyframeCurveCommand({
					trackId,
					clipId,
					propertyPath,
					componentKey,
					keyframeId,
					patch,
				}),
		);
		const command =
			commands.length === 1 ? commands[0] : new BatchCommand(commands);
		this.editor.command.execute({ command });
	}

	upsertEffectParamKeyframe({
		trackId,
		clipId,
		effectId,
		paramKey,
		time,
		value,
		interpolation,
		keyframeId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
		paramKey: string;
		time: MediaTime;
		value: number;
		interpolation?: "linear" | "hold";
		keyframeId?: string;
	}): void {
		const command = new UpsertEffectParamKeyframeCommand({
			trackId,
			clipId,
			effectId,
			paramKey,
			time,
			value,
			interpolation,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	removeEffectParamKeyframe({
		trackId,
		clipId,
		effectId,
		paramKey,
		keyframeId,
	}: {
		trackId: string;
		clipId: string;
		effectId: string;
		paramKey: string;
		keyframeId: string;
	}): void {
		const command = new RemoveEffectParamKeyframeCommand({
			trackId,
			clipId,
			effectId,
			paramKey,
			keyframeId,
		});
		this.editor.command.execute({ command });
	}

	isPreviewActive(): boolean {
		return this.previewOverlay.size > 0;
	}

	previewClips({
		updates,
	}: {
		updates: readonly {
			trackId: string;
			clipId: string;
			updates: Partial<TimelineClip>;
		}[];
	}): void {
		let changedOverlayCount = 0;
		for (const { clipId, updates: clipUpdates } of updates) {
			const existingOverlay = this.previewOverlay.get(clipId);
			const changed = Object.entries(clipUpdates).some(([key, value]) => {
				return !Object.is(
					existingOverlay?.[key as keyof TimelineClip],
					value,
				);
			});
			if (changed) {
				changedOverlayCount += 1;
				const mergedOverlay = {
					...existingOverlay,
					...clipUpdates,
				} as Partial<TimelineClip>;
				this.previewOverlay.set(clipId, mergedOverlay);
			}
		}
		const committedTracks = this.editor.sequences.getActiveSequenceOrNull()?.tracks;
		if (!committedTracks) {
			return;
		}
		if (changedOverlayCount === 0) {
			return;
		}
		this.previewTracks = this.applyPreviewOverlay(committedTracks);
		this.notify();
	}

	commitPreview(): void {
		if (this.previewOverlay.size === 0) return;
		const committedTracks = this.editor.sequences.getActiveSequenceOrNull()?.tracks;
		if (!committedTracks) {
			return;
		}
		const afterTracks =
			this.previewTracks ?? this.applyPreviewOverlay(committedTracks);
		const command = new TracksSnapshotCommand({
			before: committedTracks,
			after: afterTracks,
		});
		this.editor.command.push({ command });
		this.previewOverlay.clear();
		this.previewTracks = null;
		this.updateTracks(afterTracks);
	}

	discardPreview(): void {
		if (this.previewOverlay.size === 0) return;
		this.previewOverlay.clear();
		this.previewTracks = null;
		this.notify();
	}

	private applyPreviewOverlay(tracks: SequenceTracks): SequenceTracks {
		if (this.previewOverlay.size === 0) return tracks;

		const applyTrackOverlay = <TTrack extends TimelineTrack>(
			track: TTrack,
		): TTrack => {
			const hasOverlay = track.clips.some((clip) =>
				this.previewOverlay.has(clip.id),
			);
			if (!hasOverlay) {
				return track;
			}

			const nextClips = track.clips.map((clip) => {
				const overlay = this.previewOverlay.get(clip.id);
				return overlay
					? ({ ...clip, ...overlay } as TimelineClip)
					: clip;
			});

			return { ...track, clips: nextClips } as TTrack;
		};

		return {
			overlay: tracks.overlay.map((track) => applyTrackOverlay(track)),
			main: applyTrackOverlay(tracks.main),
			audio: tracks.audio.map((track) => applyTrackOverlay(track)),
		};
	}

	duplicateClips({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}): { trackId: string; clipId: string }[] {
		const command = new DuplicateClipsCommand({ clips });
		this.editor.command.execute({ command });
		return command.getDuplicatedClips();
	}

	toggleClipsVisibility({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}): void {
		const shouldHide = clips.some(({ trackId, clipId }) => {
			const clip = this.getClipByRef({ trackId, clipId });
			return clip && canClipBeHidden(clip) && !clip.hidden;
		});

		const nextUpdates = clips.flatMap(({ trackId, clipId }) => {
			const clip = this.getClipByRef({ trackId, clipId });
			if (!clip || !canClipBeHidden(clip)) {
				return [];
			}

			return [
				{
					trackId,
					clipId,
					patch: { hidden: shouldHide },
				},
			];
		});

		this.updateClips({ updates: nextUpdates });
	}

	toggleClipsMuted({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}): void {
		const shouldMute = clips.some(({ trackId, clipId }) => {
			const clip = this.getClipByRef({ trackId, clipId });
			return clip && canClipHaveAudio(clip) && !isClipMuted({ clip });
		});

		const nextUpdates = clips.flatMap(({ trackId, clipId }) => {
			const clip = this.getClipByRef({ trackId, clipId });
			if (!clip || !canClipHaveAudio(clip)) {
				return [];
			}

			return [
				{
					trackId,
					clipId,
					patch: { params: { muted: shouldMute } },
				},
			];
		});

		this.updateClips({ updates: nextUpdates });
	}

	getPreviewTracks(): SequenceTracks | null {
		return (
			this.previewTracks ??
			this.editor.sequences.getActiveSequenceOrNull()?.tracks ??
			null
		);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	private getClipByRef({
		trackId,
		clipId,
	}: {
		trackId: string;
		clipId: string;
	}): TimelineClip | undefined {
		return this.getTrackById({ trackId })?.clips.find(
			(clip) => clip.id === clipId,
		);
	}

	private findTrackIdForClip({
		clipId,
	}: {
		clipId: string;
	}): string | null {
		const activeSequence = this.editor.sequences.getActiveSequenceOrNull();
		if (!activeSequence) {
			return null;
		}

		if (
			activeSequence.tracks.main.clips.some(
				(clip) => clip.id === clipId,
			)
		) {
			return activeSequence.tracks.main.id;
		}

		for (const track of activeSequence.tracks.overlay) {
			if (track.clips.some((clip) => clip.id === clipId)) {
				return track.id;
			}
		}

		for (const track of activeSequence.tracks.audio) {
			if (track.clips.some((clip) => clip.id === clipId)) {
				return track.id;
			}
		}

		return null;
	}

	updateTracks(newTracks: SequenceTracks): void {
		this.previewOverlay.clear();
		this.previewTracks = null;
		this.editor.sequences.updateSequenceTracks({ tracks: newTracks });
		this.notify();
	}
}
