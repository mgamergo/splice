import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { isRetimableClip } from "@/timeline";
import { splitAnimationsAtTime } from "@/animation";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	addMediaTime,
	type MediaTime,
	roundMediaTime,
	subMediaTime,
} from "@/wasm";

export class RazorClipsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private rightSideClips: { trackId: string; clipId: string }[] = [];
	private readonly clips: { trackId: string; clipId: string }[];
	private readonly splitTime: MediaTime;
	private readonly retainSide: "both" | "left" | "right";

	constructor({
		clips,
		splitTime,
		retainSide = "both",
	}: {
		clips: { trackId: string; clipId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}) {
		super();
		this.clips = clips;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
	}

	getRightSideClips(): { trackId: string; clipId: string }[] {
		return this.rightSideClips;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		this.rightSideClips = [];

		const splitTrack = <
			TTrack extends { id: string; clips: TimelineClip[] },
		>(
			track: TTrack,
		): TTrack => {
			const clipsToRazor = this.clips.filter(
				(target) => target.trackId === track.id,
			);

			if (clipsToRazor.length === 0) {
				return track;
			}

			const clips = track.clips.flatMap((clip) => {
				const shouldSplit = clipsToRazor.some(
					(target) => target.clipId === clip.id,
				);

				if (!shouldSplit) {
					return [clip];
				}

				const effectiveStart = clip.startTime;
				const effectiveEnd = clip.startTime + clip.duration;

				if (
					this.splitTime <= effectiveStart ||
					this.splitTime >= effectiveEnd
				) {
					return [clip];
				}

				const relativeTime = subMediaTime({
					a: this.splitTime,
					b: clip.startTime,
				});
				const leftVisibleDuration = relativeTime;
				const rightVisibleDuration = subMediaTime({
					a: clip.duration,
					b: relativeTime,
				});
				const retimeRef = isRetimableClip(clip)
					? clip.retime
					: undefined;
				// Snap the source-side split point exactly once and derive the right
				// half from it. Independently rounding both spans (left and total)
				// would let a 1-tick rounding error desynchronise them, breaking the
				// invariant `leftSourceSpan + rightSourceSpan == totalSourceSpan`.
				// See the same discipline in `compute-resize.ts` (snap-once comment).
				const leftSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: leftVisibleDuration,
						retime: retimeRef,
					}),
				});
				const totalSourceSpan = roundMediaTime({
					time: getSourceSpanAtClipTime({
						clipTime: clip.duration,
						retime: retimeRef,
					}),
				});
				const rightSourceSpan = subMediaTime({
					a: totalSourceSpan,
					b: leftSourceSpan,
				});
				const { leftAnimations, rightAnimations } = splitAnimationsAtTime({
					animations: clip.animations,
					splitTime: relativeTime,
					shouldIncludeSplitBoundary: true,
				});
				let splitResult: TimelineClip[];

				const leftTrimEnd = addMediaTime({
					a: clip.trimEnd,
					b: rightSourceSpan,
				});
				const rightTrimStart = addMediaTime({
					a: clip.trimStart,
					b: leftSourceSpan,
				});

				if (this.retainSide === "left") {
					splitResult = [
						{
							...clip,
							duration: leftVisibleDuration,
							trimEnd: leftTrimEnd,
							name: `${clip.name} (left)`,
							animations: leftAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				} else if (this.retainSide === "right") {
					const newId = generateUUID();
					this.rightSideClips.push({
						trackId: track.id,
						clipId: newId,
					});
					splitResult = [
						{
							...clip,
							id: newId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: rightTrimStart,
							name: `${clip.name} (right)`,
							animations: rightAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				} else {
					const secondClipId = generateUUID();
					this.rightSideClips.push({
						trackId: track.id,
						clipId: secondClipId,
					});
					splitResult = [
						{
							...clip,
							duration: leftVisibleDuration,
							trimEnd: leftTrimEnd,
							name: `${clip.name} (left)`,
							animations: leftAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
						{
							...clip,
							id: secondClipId,
							startTime: this.splitTime,
							duration: rightVisibleDuration,
							trimStart: rightTrimStart,
							name: `${clip.name} (right)`,
							animations: rightAnimations,
							...(retimeRef !== undefined ? { retime: retimeRef } : {}),
						},
					];
				}

				return splitResult;
			});

			return { ...track, clips } as TTrack;
		};

		const updatedTracks: SequenceTracks = {
			overlay: this.savedState.overlay.map((track) => splitTrack(track)),
			main: splitTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => splitTrack(track)),
		};

		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideClips.length > 0) {
			return createClipSelectionResult(this.rightSideClips);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
