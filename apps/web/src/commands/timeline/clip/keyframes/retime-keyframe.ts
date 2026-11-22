import { EditorCore } from "@/core";
import { retimeClipKeyframe } from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateClipInSequenceTracks } from "@/timeline";
import type { AnimationPath } from "@/animation/types";
import type { SequenceTracks } from "@/timeline";
import {
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { resolveAnimationTarget } from "@/timeline/animation-targets";

export class RetimeKeyframeCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly propertyPath: AnimationPath;
	private readonly keyframeId: string;
	private readonly nextTime: MediaTime;

	constructor({
		trackId,
		clipId,
		propertyPath,
		keyframeId,
		nextTime,
	}: {
		trackId: string;
		clipId: string;
		propertyPath: AnimationPath;
		keyframeId: string;
		nextTime: MediaTime;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.propertyPath = propertyPath;
		this.keyframeId = keyframeId;
		this.nextTime = nextTime;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			update: (clip) => {
				if (!resolveAnimationTarget({ clip, path: this.propertyPath })) {
					return clip;
				}

				const boundedTime = maxMediaTime({
					a: ZERO_MEDIA_TIME,
					b: minMediaTime({ a: this.nextTime, b: clip.duration }),
				});
				return {
					...clip,
					animations: retimeClipKeyframe({
						animations: clip.animations,
						propertyPath: this.propertyPath,
						keyframeId: this.keyframeId,
						time: boundedTime,
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
