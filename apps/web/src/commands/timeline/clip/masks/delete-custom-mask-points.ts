import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import {
	getFreeformPathClosedStateAfterPointRemoval,
	removeFreeformPathPoints,
} from "@/masks/freeform/path";
import type { FreeformPathMask } from "@/masks/types";
import { isMaskableClip, updateClipInSequenceTracks } from "@/timeline";
import type { MaskableClip, SequenceTracks } from "@/timeline";

function deletePointsFromFreeformPathMask({
	mask,
	pointIds,
}: {
	mask: FreeformPathMask;
	pointIds: string[];
}): FreeformPathMask {
	const points = mask.params.path;
	const nextPoints = removeFreeformPathPoints({ points, pointIds });
	if (nextPoints.length === points.length) {
		return mask;
	}

	return {
		...mask,
		params: {
			...mask.params,
			path: nextPoints,
			closed: getFreeformPathClosedStateAfterPointRemoval({
				wasClosed: mask.params.closed,
				remainingPointCount: nextPoints.length,
			}),
		},
	};
}

function deletePointsFromClipMask({
	clip,
	maskId,
	pointIds,
}: {
	clip: MaskableClip;
	maskId: string;
	pointIds: string[];
}): { clip: MaskableClip; didDeletePoints: boolean } {
	const currentMasks = clip.masks ?? [];
	let didDeletePoints = false;
	const nextMasks = currentMasks.map((mask) => {
		if (mask.id !== maskId || mask.type !== "freeform") {
			return mask;
		}

		const nextMask = deletePointsFromFreeformPathMask({
			mask,
			pointIds,
		});
		didDeletePoints ||= nextMask !== mask;
		return nextMask;
	});

	return {
		clip: didDeletePoints ? { ...clip, masks: nextMasks } : clip,
		didDeletePoints,
	};
}

export class DeleteFreeformPathMaskPointsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly maskId: string;
	private readonly pointIds: string[];

	constructor({
		trackId,
		clipId,
		maskId,
		pointIds,
	}: {
		trackId: string;
		clipId: string;
		maskId: string;
		pointIds: string[];
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.maskId = maskId;
		this.pointIds = pointIds;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		let didDeletePoints = false;
		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			clipPredicate: isMaskableClip,
			update: (clip) => {
				if (!isMaskableClip(clip)) return clip;
				const result = deletePointsFromClipMask({
					clip,
					maskId: this.maskId,
					pointIds: this.pointIds,
				});
				didDeletePoints ||= result.didDeletePoints;
				return result.clip;
			},
		});

		if (didDeletePoints) {
			editor.timeline.updateTracks(updatedTracks);
			return {
				selection: {
					selectedMaskPoints: null,
				},
			};
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
