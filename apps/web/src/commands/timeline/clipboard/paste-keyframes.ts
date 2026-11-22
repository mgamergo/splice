import { EditorCore } from "@/core";
import {
	getKeyframeAtTime,
	updateScalarKeyframeCurve,
	upsertPathKeyframe,
} from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import type { KeyframeClipboardItem } from "@/clipboard";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import { updateClipInSequenceTracks } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	minMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

function pasteKeyframesIntoClip({
	clip,
	time,
	clipboardItems,
}: {
	clip: TimelineClip;
	time: MediaTime;
	clipboardItems: KeyframeClipboardItem[];
}): TimelineClip {
	let nextClip = clip;

	for (const item of clipboardItems) {
		const target = resolveAnimationTarget({
			clip: nextClip,
			path: item.propertyPath,
		});
		if (!target) {
			continue;
		}

		const keyframeTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: minMediaTime({
				a: addMediaTime({ a: time, b: item.timeOffset }),
				b: nextClip.duration,
			}),
		});
		const nextAnimations = upsertPathKeyframe({
			animations: nextClip.animations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
			value: item.value,
			interpolation: item.interpolation,
			keyframeId: generateUUID(),
			channelLayout: target.channelLayout,
			coerceValue: target.coerceValue,
		});
		const pastedKeyframe = getKeyframeAtTime({
			animations: nextAnimations,
			propertyPath: item.propertyPath,
			time: keyframeTime,
		});

		let patchedAnimations = nextAnimations;
		if (pastedKeyframe) {
			for (const curvePatch of item.curvePatches) {
				const nextPatchedAnimations = updateScalarKeyframeCurve({
					animations: patchedAnimations,
					propertyPath: item.propertyPath,
					componentKey: curvePatch.componentKey,
					keyframeId: pastedKeyframe.id,
					patch: curvePatch.patch,
				});
				patchedAnimations = nextPatchedAnimations ?? patchedAnimations;
			}
		}

		nextClip = {
			...nextClip,
			animations: patchedAnimations,
		};
	}

	return nextClip;
}

export class PasteKeyframesCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly time: MediaTime;
	private readonly clipboardItems: KeyframeClipboardItem[];

	constructor({
		trackId,
		clipId,
		time,
		clipboardItems,
	}: {
		trackId: string;
		clipId: string;
		time: MediaTime;
		clipboardItems: KeyframeClipboardItem[];
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.time = time;
		this.clipboardItems = clipboardItems;
	}

	execute(): CommandResult | undefined {
		if (this.clipboardItems.length === 0) {
			return undefined;
		}

		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			update: (clip) =>
				pasteKeyframesIntoClip({
					clip,
					time: this.time,
					clipboardItems: this.clipboardItems,
				}),
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
