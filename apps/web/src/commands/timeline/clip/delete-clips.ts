import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks } from "@/timeline";
import { EditorCore } from "@/core";
import type { TimelineTrack } from "@/timeline";

function removeTrackClips<TTrack extends TimelineTrack>({
	track,
	clips,
}: {
	track: TTrack;
	clips: { trackId: string; clipId: string }[];
}): TTrack {
	const nextClips = track.clips.filter(
		(clip) =>
			!clips.some(
				(target) =>
					target.trackId === track.id && target.clipId === clip.id,
			),
	);

	return { ...track, clips: nextClips } as TTrack;
}

export class DeleteClipsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private readonly clips: { trackId: string; clipId: string }[];

	constructor({
		clips,
	}: {
		clips: { trackId: string; clipId: string }[];
	}) {
		super();
		this.clips = clips;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		const updatedTracks: SequenceTracks = {
			overlay: this.savedState.overlay.map((track) =>
				removeTrackClips({ track, clips: this.clips }),
			),
			main: removeTrackClips({
				track: this.savedState.main,
				clips: this.clips,
			}),
			audio: this.savedState.audio.map((track) =>
				removeTrackClips({ track, clips: this.clips }),
			),
		};

		editor.timeline.updateTracks(updatedTracks);

		return {
			selection: {
				selectedClips: [],
				selectedKeyframes: [],
				keyframeSelectionAnchor: null,
				selectedMaskPoints: null,
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
