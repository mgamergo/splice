import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import {
	buildEffectParamPath,
	upsertPathKeyframe,
} from "@/animation";
import { updateClipInSequenceTracks } from "@/timeline";
import { isVisualClip } from "@/timeline/clip-utils";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import type { AnimationInterpolation } from "@/animation/types";
import type { SequenceTracks } from "@/timeline";
import {
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class UpsertEffectParamKeyframeCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly effectId: string;
	private readonly paramKey: string;
	private readonly time: MediaTime;
	private readonly value: number | string | boolean;
	private readonly interpolation: AnimationInterpolation | undefined;
	private readonly keyframeId: string | undefined;

	constructor({
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
		value: number | string | boolean;
		interpolation?: AnimationInterpolation;
		keyframeId?: string;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.effectId = effectId;
		this.paramKey = paramKey;
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
			clipPredicate: isVisualClip,
			update: (clip) => {
				const boundedTime = maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: minMediaTime({ a: this.time, b: clip.duration }),
				});
				const propertyPath = buildEffectParamPath({
					effectId: this.effectId,
					paramKey: this.paramKey,
				});
				const target = resolveAnimationTarget({
					clip,
					path: propertyPath,
				});
				if (!target) {
					return clip;
				}

				const animations = upsertPathKeyframe({
					animations: clip.animations,
					propertyPath,
					time: boundedTime,
					value: this.value,
					interpolation: this.interpolation,
					keyframeId: this.keyframeId,
					channelLayout: target.channelLayout,
					coerceValue: target.coerceValue,
				});
				return { ...clip, animations };
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
