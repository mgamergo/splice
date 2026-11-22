import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { upsertPathKeyframe } from "@/animation";
import { updateClipInSequenceTracks } from "@/timeline";
import type { SequenceTracks } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type {
	AnimationPath,
	AnimationInterpolation,
} from "@/animation/types";
import type { ParamValue } from "@/params";
import {
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class UpsertKeyframeCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly propertyPath: AnimationPath;
	private readonly time: MediaTime;
	private readonly value: ParamValue;
	private readonly interpolation: AnimationInterpolation | undefined;
	private readonly keyframeId: string | undefined;

	constructor({
		trackId,
		clipId,
		propertyPath,
		time,
		value,
		interpolation,
		keyframeId,
	}: {
		trackId: string;
		clipId: string;
		propertyPath: AnimationPath;
		time: MediaTime;
		value: ParamValue;
		interpolation?: AnimationInterpolation;
		keyframeId?: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.propertyPath = propertyPath;
		this.time = time;
		this.value = value;
		this.interpolation = interpolation;
		this.keyframeId = keyframeId;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			update: (clip) => {
				const target = resolveAnimationTarget({
					clip,
					path: this.propertyPath,
				});
				if (!target) {
					return clip;
				}

				const boundedTime = maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: minMediaTime({ a: this.time, b: clip.duration }),
				});
				return {
					...clip,
					animations: upsertPathKeyframe({
						animations: clip.animations,
						propertyPath: this.propertyPath,
						time: boundedTime,
						value: this.value,
						interpolation: this.interpolation,
						keyframeId: this.keyframeId,
						channelLayout: target.channelLayout,
						coerceValue: target.coerceValue,
					}),
				};
			},
		});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}
