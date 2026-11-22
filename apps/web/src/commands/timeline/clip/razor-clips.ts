import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { razorClip } from "@/timeline/razor";
import type { MediaTime } from "@/wasm";

export class RazorClipsCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private rightSideClips: { trackId: string; clipId: string }[] = [];
	private readonly clips: { trackId: string; clipId: string }[];
	private readonly splitTime: MediaTime;
	private readonly retainSide: "both" | "left" | "right";

	constructor({
		clips,
		splitTime,
		retainSide = "both",
	}: {
		clips: { trackId: string; clipId: string }[];
		splitTime: MediaTime;
		retainSide?: "both" | "left" | "right";
	}) {
		super();
		this.clips = clips;
		this.splitTime = splitTime;
		this.retainSide = retainSide;
	}

	getRightSideClips(): { trackId: string; clipId: string }[] {
		return this.rightSideClips;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		this.rightSideClips = [];

		const splitTrack = <
			TTrack extends { id: string; clips: TimelineClip[] },
		>(
			track: TTrack,
		): TTrack => {
			const clipsToRazor = this.clips.filter(
				(target) => target.trackId === track.id,
			);

			if (clipsToRazor.length === 0) {
				return track;
			}

			const clips = track.clips.flatMap((clip) => {
				const shouldSplit = clipsToRazor.some(
					(target) => target.clipId === clip.id,
				);

				if (!shouldSplit) {
					return [clip];
				}

				const rightClipId = generateUUID();
				const cut = razorClip({ clip, at: this.splitTime, rightClipId });
				if (!cut) {
					return [clip];
				}
				const left = { ...cut.left, name: `${clip.name} (left)` };
				const right = { ...cut.right, name: `${clip.name} (right)` };
				if (this.retainSide !== "left") {
					this.rightSideClips.push({ trackId: track.id, clipId: rightClipId });
				}
				const splitResult: TimelineClip[] =
					this.retainSide === "left"
						? [left]
						: this.retainSide === "right"
							? [right]
							: [left, right];

				return splitResult;
			});

			return { ...track, clips } as TTrack;
		};

		const updatedTracks: SequenceTracks = {
			overlay: this.savedState.overlay.map((track) => splitTrack(track)),
			main: splitTrack(this.savedState.main),
			audio: this.savedState.audio.map((track) => splitTrack(track)),
		};

		editor.timeline.updateTracks(updatedTracks);

		if (this.rightSideClips.length > 0) {
			return createClipSelectionResult(this.rightSideClips);
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
