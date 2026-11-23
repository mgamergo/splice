import type { EditOp } from "@splice/bridge/ops";
import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { Marker, RemovalMarker, TSequence } from "@/timeline";
import {
	RemovalTakeError,
	clearBestTake,
	resolveTake,
	restoreTakeClips,
	swapTakeClips,
} from "@/timeline/markers/removal-takes";
import { updateSequenceInArray } from "@/timeline/sequences";
import { roundMediaTime } from "@/wasm";

export type RemovalMarkerEdit = Extract<
	EditOp,
	{ op: "restore_takes" | "swap_take" }
>;

export class EditRemovalMarkerCommand extends Command {
	readonly ignoresRippleToggle = true;
	private before: TSequence[] | null = null;
	private after: TSequence[] | null = null;
	private result: CommandResult | undefined;

	constructor(
		private readonly options: { editor: EditorCore; edit: RemovalMarkerEdit },
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const { editor, edit } = this.options;
		const sequence = editor.sequences.getActiveSequence();
		const marker = sequence.markers.find(
			(candidate): candidate is RemovalMarker =>
				candidate.data?.kind === "removal" && candidate.id === edit.markerId,
		);
		if (!marker) {
			throw new RemovalTakeError(`Unknown removal marker: ${edit.markerId}`);
		}

		const projectItems = editor.media.getProjectItems();
		const { badTakes, bestTake } = marker.data;
		const chosen =
			edit.takeIndex === undefined ? undefined : badTakes[edit.takeIndex];
		if (edit.takeIndex !== undefined && !chosen) {
			throw new RemovalTakeError("That stored take is no longer available.");
		}
		const remaining = badTakes.filter((_, index) => index !== edit.takeIndex);
		const update =
			edit.op === "swap_take" && chosen
				? swapTakeClips({
						tracks: sequence.tracks,
						marker,
						best: resolveTake({ take: bestTake, projectItems }),
						chosen: resolveTake({ take: chosen, projectItems }),
					})
				: {
						...restoreTakeClips({
							tracks: sequence.tracks,
							takes: (chosen ? [chosen] : badTakes).map((take) =>
								resolveTake({ take, projectItems }),
							),
							at: marker.time,
						}),
						start: marker.time,
						end: marker.time,
					};

		const shiftMarkerTime = ({ time }: Marker) =>
			time >= update.end
				? roundMediaTime({ time: time + update.delta })
				: time >= update.start
					? update.start
					: time;
		const markers = sequence.markers
			.flatMap((candidate): Marker[] => {
				if (candidate === marker) {
					if (edit.op === "restore_takes") {
						return chosen && remaining.length
							? [{ ...marker, data: { ...marker.data, badTakes: remaining } }]
							: [];
					}
					if (chosen) {
						return [
							{
								...marker,
								time: shiftMarkerTime(marker),
								data: {
									...marker.data,
									bestTake: chosen,
									badTakes: badTakes.map((take, index) =>
										index === edit.takeIndex ? bestTake : take,
									),
								},
							},
						];
					}
				}
				const time = shiftMarkerTime(candidate);
				return [time === candidate.time ? candidate : { ...candidate, time }];
			})
			.sort((a, b) => a.time - b.time);

		const tracks =
			edit.op === "restore_takes" && (!chosen || remaining.length === 0)
				? clearBestTake({ tracks: update.tracks, markerId: marker.id })
				: update.tracks;
		this.before = editor.sequences.getSequences();
		this.after = updateSequenceInArray({
			sequences: this.before,
			sequenceId: sequence.id,
			updates: { tracks, markers },
		});
		const remainingIds = new Set(
			[
				update.tracks.main,
				...update.tracks.overlay,
				...update.tracks.audio,
			].flatMap((track) => track.clips.map(({ id }) => id)),
		);
		const selected = editor.selection.getSnapshot().selectedClips;
		const stillSelected = selected.filter(({ clipId }) =>
			remainingIds.has(clipId),
		);
		this.result =
			stillSelected.length < selected.length
				? createClipSelectionResult(stillSelected)
				: undefined;
		editor.sequences.setSequences({ sequences: this.after });
		return this.result;
	}

	undo(): void {
		if (this.before)
			this.options.editor.sequences.setSequences({ sequences: this.before });
	}

	redo(): CommandResult | undefined {
		if (!this.after) return this.execute();
		this.options.editor.sequences.setSequences({ sequences: this.after });
		return this.result;
	}
}
