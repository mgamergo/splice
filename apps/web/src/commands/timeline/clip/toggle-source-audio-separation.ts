import { EditorCore } from "@/core";
import { Command, type CommandResult } from "@/commands/base-command";
import {
	buildSeparatedAudioClip,
	canExtractSourceAudio,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import {
	applyPlacement,
	resolveTrackPlacement,
} from "@/timeline/placement";
import { updateClipInSequenceTracks } from "@/timeline/track-clip-update";
import type {
	SequenceTracks,
	TimelineClip,
	VideoClip,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";

export class ToggleSourceAudioSeparationCommand extends Command {
	private savedState: SequenceTracks | null = null;

	constructor(
		private readonly params: {
			trackId: string;
			clipId: string;
		},
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const sourceTrack = [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		].find((track) => track.id === this.params.trackId);
		if (!sourceTrack) {
			return;
		}
		const sourceClip = sourceTrack.clips.find(
			(clip) => clip.id === this.params.clipId,
		) as TimelineClip | undefined;
		if (!sourceClip || sourceClip.type !== "video") {
			return;
		}
		const videoClip: VideoClip = sourceClip;

		if (isSourceAudioSeparated({ clip: videoClip })) {
			editor.timeline.updateTracks(
				updateSourceAudioEnabled({
					tracks: this.savedState,
					trackId: this.params.trackId,
					clipId: this.params.clipId,
					isSourceAudioEnabled: true,
				}),
			);
			return;
		}

		const projectItem = editor.media
			.getProjectItems()
			.find((projectItem) => projectItem.id === videoClip.mediaId);
		if (!canExtractSourceAudio(videoClip, projectItem)) {
			return;
		}
		if (videoClip.duration <= 0) {
			return;
		}

		const separatedAudioClip = {
			...buildSeparatedAudioClip({
				sourceClip: videoClip,
			}),
			id: generateUUID(),
		};
		const placementResult = resolveTrackPlacement({
			tracks: this.savedState,
			trackType: "audio",
			timeSpans: [
				{
					startTime: separatedAudioClip.startTime,
					duration: separatedAudioClip.duration,
				},
			],
			strategy: { type: "firstAvailable" },
		});
		if (!placementResult) {
			return;
		}
		const appliedPlacement = applyPlacement({
			tracks: this.savedState,
			placementResult,
			clips: [separatedAudioClip],
		});
		if (!appliedPlacement) {
			return;
		}

		editor.timeline.updateTracks(
			updateSourceAudioEnabled({
				tracks: appliedPlacement.updatedTracks,
				trackId: this.params.trackId,
				clipId: this.params.clipId,
				isSourceAudioEnabled: false,
			}),
		);
	}

	undo(): void {
		if (!this.savedState) {
			return;
		}

		const editor = EditorCore.getInstance();
		editor.timeline.updateTracks(this.savedState);
	}
}

function updateSourceAudioEnabled({
	tracks,
	trackId,
	clipId,
	isSourceAudioEnabled,
}: {
	tracks: SequenceTracks;
	trackId: string;
	clipId: string;
	isSourceAudioEnabled: boolean;
}): SequenceTracks {
	return updateClipInSequenceTracks({
		tracks,
		trackId,
		clipId,
		clipPredicate: (clip): clip is VideoClip =>
			clip.type === "video",
		update: (clip) => ({
			...clip,
			isSourceAudioEnabled,
		}),
	});
}
