import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import type { MediaTime } from "@/wasm";

interface DuplicateClipsParams {
	clips: { trackId: string; clipId: string }[];
}

export class DuplicateClipsCommand extends Command {
	private duplicatedClips: { trackId: string; clipId: string }[] = [];
	private savedState: SequenceTracks | null = null;
	private clips: DuplicateClipsParams["clips"];

	constructor({ clips }: DuplicateClipsParams) {
		super();
		this.clips = clips;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		this.duplicatedClips = [];

		let updatedTracks = this.savedState;

		for (const track of [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		]) {
			const clipsToDuplicate = this.clips.filter(
				(clipEntry) => clipEntry.trackId === track.id,
			);

			if (clipsToDuplicate.length === 0) {
				continue;
			}

			const clipIdsToDuplicate = new Set(
				clipsToDuplicate.map((clip) => clip.clipId),
			);
			const newTrackClips: TimelineClip[] = [];

			for (const clip of track.clips) {
				if (!clipIdsToDuplicate.has(clip.id)) {
					continue;
				}

				const newId = generateUUID();
				newTrackClips.push(
					buildDuplicateClip({
						clip,
						id: newId,
						startTime: clip.startTime,
					}),
				);
			}

			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType: track.type,
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "highest" },
			});
			if (!placementResult || placementResult.kind !== "newTrack") {
				continue;
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				clips: newTrackClips,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;

			for (const clip of newTrackClips) {
				this.duplicatedClips.push({
					trackId: applied.targetTrackId,
					clipId: clip.id,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		if (this.duplicatedClips.length > 0) {
			return createClipSelectionResult(this.duplicatedClips);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getDuplicatedClips(): { trackId: string; clipId: string }[] {
		return this.duplicatedClips;
	}
}

function buildDuplicateClip({
	clip,
	id,
	startTime,
}: {
	clip: TimelineClip;
	id: string;
	startTime: MediaTime;
}): TimelineClip {
	return {
		...clip,
		id,
		name: `${clip.name} (copy)`,
		startTime,
		animations: cloneAnimations({
			animations: clip.animations,
			shouldRegenerateKeyframeIds: true,
		}),
	};
}
