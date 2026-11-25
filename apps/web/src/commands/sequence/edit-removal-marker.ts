import {
	rebuildCaptions,
	recoverCaptionLayouts,
	saveCaptionCorrections,
	withoutCaptionTrack,
} from "@/agent/captions";
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
		const { badTakePlacements, ...data } = marker.data;
		const { badTakes, bestTake } = data;
		const chosen =
			edit.takeIndex === undefined ? undefined : badTakes[edit.takeIndex];
		if (edit.takeIndex !== undefined && !chosen) {
			throw new RemovalTakeError("That stored take is no longer available.");
		}
		const remaining = badTakes.filter((_, index) => index !== edit.takeIndex);
		// Derived captions neither block nor follow the take edit; they're rebuilt after.
		const sourceTracks = sequence.captions
			? withoutCaptionTrack({ tracks: sequence.tracks })
			: sequence.tracks;
		const swap =
			edit.op === "swap_take" && chosen
				? swapTakeClips({
						tracks: sourceTracks,
						marker,
						best: resolveTake({ take: bestTake, projectItems }),
						chosen: resolveTake({ take: chosen, projectItems }),
						chosenPlacements: badTakePlacements?.[edit.takeIndex] ?? undefined,
					})
				: undefined;
		const update = swap ?? {
			...restoreTakeClips({
				tracks: sourceTracks,
				takes: badTakes.flatMap((take, index) =>
					edit.takeIndex === undefined || index === edit.takeIndex
						? [
								{
									take: resolveTake({ take, projectItems }),
									placements: badTakePlacements?.[index],
								},
							]
						: [],
				),
				at: marker.time,
			}),
			start: marker.time,
			end: marker.time,
		};
		const nextPlacements = swap
			? badTakes.map((_, index) =>
					index === edit.takeIndex
						? swap.previousPlacements
						: (badTakePlacements?.[index] ?? null),
				)
			: badTakePlacements?.filter((_, index) => index !== edit.takeIndex);
		const markerData = {
			...data,
			...(nextPlacements?.some((ids) => ids !== null)
				? { badTakePlacements: nextPlacements }
				: {}),
		};

		const shiftMarkerTime = ({ time }: Marker) =>
			time >= update.end
				? roundMediaTime({ time: time + update.delta })
				: time >= update.start
					? update.start
					: time;
		const markerIndex = sequence.markers.indexOf(marker);
		const markers = sequence.markers
			.flatMap((candidate, index): Marker[] => {
				if (candidate === marker) {
					if (edit.op === "restore_takes") {
						return chosen && remaining.length
							? [{ ...marker, data: { ...markerData, badTakes: remaining } }]
							: [];
					}
					if (chosen) {
						return [
							{
								...marker,
								time: shiftMarkerTime(marker),
								data: {
									...markerData,
									bestTake: chosen,
									badTakes: badTakes.map((take, index) =>
										index === edit.takeIndex ? bestTake : take,
									),
								},
							},
						];
					}
				}
				// Markers that collapsed to one time keep their source order: those
				// before this one stay ahead of the restored takes.
				if (
					edit.op === "restore_takes" &&
					candidate.time === marker.time &&
					index < markerIndex
				)
					return [candidate];
				const time = shiftMarkerTime(candidate);
				return [time === candidate.time ? candidate : { ...candidate, time }];
			})
			.sort((a, b) => a.time - b.time);

		const canvasSize = editor.project.getActive().settings.canvasSize;
		const previousTracks = recoverCaptionLayouts({
			tracks: sequence.tracks,
			captions: sequence.captions,
			canvasSize,
		});
		const captions = saveCaptionCorrections({
			tracks: previousTracks,
			captions: sequence.captions,
		});
		const tracks = rebuildCaptions({
			sequence: { ...sequence, captions, tracks: previousTracks },
			tracks:
				edit.op === "restore_takes" && (!chosen || remaining.length === 0)
					? clearBestTake({ tracks: update.tracks, markerId: marker.id })
					: update.tracks,
			canvasSize,
			window: update,
		});
		this.before = editor.sequences.getSequences();
		this.after = updateSequenceInArray({
			sequences: this.before,
			sequenceId: sequence.id,
			updates: { tracks, markers, captions },
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
