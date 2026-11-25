import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks } from "@/timeline";
import { tombstoneGraphics } from "@/agent/graphics";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
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
	private deleteGraphics?: UpdateSequenceCommand;
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
		const sequence = editor.sequences.getActiveSequence();
		this.savedState = sequence.tracks;
		this.deleteGraphics = undefined;

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

		const graphicIds = sequence.graphics
			? sequence.tracks.overlay.flatMap((track) =>
					track.clips.flatMap((clip) => this.clips.some(({ trackId, clipId }) => trackId === track.id && clipId === clip.id) && clip.graphicId ? [clip.graphicId] : []),
				)
			: [];
		const graphics = tombstoneGraphics({ graphics: sequence.graphics, graphicIds });
		if (graphics !== sequence.graphics) {
			this.deleteGraphics = new UpdateSequenceCommand({
				editor,
				sequenceId: sequence.id,
				updates: { tracks: updatedTracks, graphics },
				label: "Delete graphics",
			});
			this.deleteGraphics.execute();
		} else {
			editor.timeline.updateTracks(updatedTracks);
		}

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
		if (this.deleteGraphics) {
			this.deleteGraphics.undo();
		} else if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}
