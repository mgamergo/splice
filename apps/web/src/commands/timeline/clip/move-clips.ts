import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SequenceTracks, TimelineClip, TimelineTrack } from "@/timeline";
import {
	buildEmptyTrack,
	validateClipTrackCompatibility,
} from "@/timeline/placement";
import type {
	PlannedClipMove,
	PlannedTrackCreation,
} from "@/timeline/group-move";
import { findTrackInSequenceTracks } from "@/timeline/track-clip-update";

export class MoveClipCommand extends Command {
	private savedState: SequenceTracks | null = null;

	constructor({
		moves,
		createTracks = [],
	}: {
		moves: PlannedClipMove[];
		createTracks?: PlannedTrackCreation[];
	}) {
		super();
		this.moves = moves;
		this.createTracks = createTracks;
	}

	private readonly moves: PlannedClipMove[];
	private readonly createTracks: PlannedTrackCreation[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;

		let tracksToUpdate = this.savedState;
		for (const createTrack of [...this.createTracks].sort(
			(firstTrack, secondTrack) => firstTrack.index - secondTrack.index,
		)) {
			tracksToUpdate = insertTrackAtDisplayIndex({
				tracks: tracksToUpdate,
				track: buildEmptyTrack({
					id: createTrack.id,
					type: createTrack.type,
				}),
				insertIndex: createTrack.index,
			});
		}

		const movedClipsById = new Map<string, TimelineClip>();
		for (const move of this.moves) {
			const sourceTrack = findTrackInSequenceTracks({
				tracks: this.savedState,
				trackId: move.sourceTrackId,
			});
			const sourceClip = sourceTrack?.clips.find(
				(trackClip) => trackClip.id === move.clipId,
			);
			if (!sourceTrack || !sourceClip) {
				throw new Error("Source track or clip not found");
			}

			const targetTrack = findTrackInSequenceTracks({
				tracks: tracksToUpdate,
				trackId: move.targetTrackId,
			});
			if (!targetTrack) {
				throw new Error("Target track not found");
			}

			const validation = validateClipTrackCompatibility({
				clip: sourceClip,
				track: targetTrack,
			});
			if (!validation.isValid) {
				throw new Error(validation.errorMessage);
			}

			movedClipsById.set(move.clipId, {
				...sourceClip,
				startTime: move.newStartTime,
			});
		}

		const movedClipIds = new Set(this.moves.map((move) => move.clipId));
		const movedClipsByTargetTrackId = new Map<string, TimelineClip[]>();
		for (const move of this.moves) {
			const movedClip = movedClipsById.get(move.clipId);
			if (!movedClip) {
				continue;
			}

			const nextTargetClips =
				movedClipsByTargetTrackId.get(move.targetTrackId) ?? [];
			nextTargetClips.push(movedClip);
			movedClipsByTargetTrackId.set(move.targetTrackId, nextTargetClips);
		}

		const updatedTracks = mapSequenceTracks({
			tracks: tracksToUpdate,
			update: (track) => ({
				...track,
				clips: [
					...track.clips.filter(
						(clip) => !movedClipIds.has(clip.id),
					),
					...(movedClipsByTargetTrackId.get(track.id) ?? []),
				],
			}),
		});

		editor.timeline.updateTracks(updatedTracks);
		return createClipSelectionResult(
			this.moves.map(({ clipId, targetTrackId }) => ({
				trackId: targetTrackId,
				clipId,
			})),
		);
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}
}

function mapSequenceTracks({
	tracks,
	update,
}: {
	tracks: SequenceTracks;
	update: <TTrack extends TimelineTrack>(track: TTrack) => TTrack;
}): SequenceTracks {
	return {
		overlay: tracks.overlay.map((track) => update(track)),
		main: update(tracks.main),
		audio: tracks.audio.map((track) => update(track)),
	};
}

function insertTrackAtDisplayIndex({
	tracks,
	track,
	insertIndex,
}: {
	tracks: SequenceTracks;
	track: TimelineTrack;
	insertIndex: number;
}): SequenceTracks {
	if (track.type === "audio") {
		const audioInsertIndex = Math.max(
			0,
			Math.min(insertIndex - tracks.overlay.length - 1, tracks.audio.length),
		);
		return {
			...tracks,
			audio: [
				...tracks.audio.slice(0, audioInsertIndex),
				track,
				...tracks.audio.slice(audioInsertIndex),
			],
		};
	}

	const overlayInsertIndex = Math.max(
		0,
		Math.min(insertIndex, tracks.overlay.length),
	);
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			track,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}
