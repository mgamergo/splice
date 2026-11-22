import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import { insertPointOnFreeformSegment } from "@/masks/freeform/definition";
import type { ClipBounds } from "@/preview/clip-bounds";
import type { FreeformPathMask } from "@/masks/types";
import { isMaskableClip, updateClipInSequenceTracks } from "@/timeline";
import type { MaskableClip, SequenceTracks } from "@/timeline";

function insertPointIntoFreeformPathMask({
	mask,
	segmentIndex,
	canvasPoint,
	bounds,
}: {
	mask: FreeformPathMask;
	segmentIndex: number;
	canvasPoint: { x: number; y: number };
	bounds: ClipBounds;
}): { mask: FreeformPathMask; insertedPointId: string | null } {
	const result = insertPointOnFreeformSegment({
		params: mask.params,
		segmentIndex,
		canvasPoint,
		bounds,
	});
	if (!result) {
		return {
			mask,
			insertedPointId: null,
		};
	}

	return {
		mask: {
			...mask,
			params: result.params,
		},
		insertedPointId: result.pointId,
	};
}

function insertPointIntoClipMask({
	clip,
	maskId,
	segmentIndex,
	canvasPoint,
	bounds,
}: {
	clip: MaskableClip;
	maskId: string;
	segmentIndex: number;
	canvasPoint: { x: number; y: number };
	bounds: ClipBounds;
}): {
	clip: MaskableClip;
	didInsertPoint: boolean;
	insertedPointId: string | null;
} {
	const currentMasks = clip.masks ?? [];
	let insertedPointId: string | null = null;
	let didInsertPoint = false;

	const nextMasks = currentMasks.map((mask) => {
		if (mask.id !== maskId || mask.type !== "freeform") {
			return mask;
		}

		const result = insertPointIntoFreeformPathMask({
			mask,
			segmentIndex,
			canvasPoint,
			bounds,
		});
		if (result.insertedPointId) {
			insertedPointId = result.insertedPointId;
			didInsertPoint = true;
		}
		return result.mask;
	});

	return {
		clip: didInsertPoint ? { ...clip, masks: nextMasks } : clip,
		didInsertPoint,
		insertedPointId,
	};
}

export class InsertFreeformPathMaskPointCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly trackId: string;
	private readonly clipId: string;
	private readonly maskId: string;
	private readonly segmentIndex: number;
	private readonly canvasPoint: { x: number; y: number };
	private readonly bounds: ClipBounds;

	constructor({
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
	}) {
		super();
		this.trackId = trackId;
		this.clipId = clipId;
		this.maskId = maskId;
		this.segmentIndex = segmentIndex;
		this.canvasPoint = canvasPoint;
		this.bounds = bounds;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		let didInsertPoint = false;
		let insertedPointId: string | null = null;
		const updatedTracks = updateClipInSequenceTracks({
			tracks: this.savedState,
			trackId: this.trackId,
			clipId: this.clipId,
			clipPredicate: isMaskableClip,
			update: (clip) => {
				if (!isMaskableClip(clip)) return clip;
				const result = insertPointIntoClipMask({
					clip,
					maskId: this.maskId,
					segmentIndex: this.segmentIndex,
					canvasPoint: this.canvasPoint,
					bounds: this.bounds,
				});
				didInsertPoint ||= result.didInsertPoint;
				insertedPointId ??= result.insertedPointId;
				return result.clip;
			},
		});

		if (!didInsertPoint || !insertedPointId) {
			return undefined;
		}

		editor.timeline.updateTracks(updatedTracks);
		return {
			selection: {
				selectedMaskPoints: {
					trackId: this.trackId,
					clipId: this.clipId,
					maskId: this.maskId,
					pointIds: [insertedPointId],
				},
			},
		};
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
