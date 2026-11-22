import { EditorCore } from "@/core";
import {
	hasKeyframesForPath,
	removeClipKeyframe,
} from "@/animation";
import { Command, type CommandResult } from "@/commands/base-command";
import { updateClipInSequenceTracks } from "@/timeline";
import type { AnimationPath } from "@/animation/types";
import type { ParamValue } from "@/params";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import { resolveAnimationTarget } from "@/timeline/animation-targets";

function removeKeyframeAndPersist({
	clip,
	propertyPath,
	keyframeId,
	valueAtPlayhead,
}: {
	clip: TimelineClip;
	propertyPath: AnimationPath;
	keyframeId: string;
	valueAtPlayhead: ParamValue | null;
}): TimelineClip {
	const target = resolveAnimationTarget({ clip, path: propertyPath });
	if (!target) {
		return clip;
	}

	const nextAnimations = removeClipKeyframe({
		animations: clip.animations,
		propertyPath,
		keyframeId,
	});

	const isChannelNowEmpty = !hasKeyframesForPath({
		animations: nextAnimations,
		propertyPath,
	});

	// When clearing all keyframes, preserve the value at the playhead (what the user was seeing)
	const shouldPersistToBase = isChannelNowEmpty && valueAtPlayhead !== null;

	const baseClip = shouldPersistToBase
		? target.setBaseValue({ value: valueAtPlayhead })
		: clip;

	return { ...baseClip, animations: nextAnimations };
}

export class RemoveKeyframeCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly propertyPath: AnimationPath;
	private readonly keyframeId: string;
	private readonly valueAtPlayhead: ParamValue | null;

	constructor({
		trackId,
		clipId,
		propertyPath,
		keyframeId,
		valueAtPlayhead,
	}: {
		trackId: string;
		clipId: string;
		propertyPath: AnimationPath;
		keyframeId: string;
		valueAtPlayhead: ParamValue | null;
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.propertyPath = propertyPath;
		this.keyframeId = keyframeId;
		this.valueAtPlayhead = valueAtPlayhead;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			update: (clip) =>
				removeKeyframeAndPersist({
					clip,
					propertyPath: this.propertyPath,
					keyframeId: this.keyframeId,
					valueAtPlayhead: this.valueAtPlayhead,
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
