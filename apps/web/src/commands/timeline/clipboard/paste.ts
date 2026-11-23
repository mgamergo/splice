import {
	Command,
	createClipSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { SequenceTracks, TimelineClip } from "@/timeline";
import type { ClipClipboardItem } from "@/clipboard";
import { generateUUID } from "@/utils/id";
import {
	applyPlacement,
	resolveTrackPlacement,
	enforceMainTrackStart,
} from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import {
	addMediaTime,
	type MediaTime,
	maxMediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export class PasteCommand extends Command {
	private savedState: SequenceTracks | null = null;
	private pastedClips: { trackId: string; clipId: string }[] = [];
	private readonly time: MediaTime;
	private readonly clipboardItems: ClipClipboardItem[];

	constructor({
		time,
		clipboardItems,
	}: {
		time: MediaTime;
		clipboardItems: ClipClipboardItem[];
	}) {
		super();
		this.time = time;
		this.clipboardItems = clipboardItems;
	}

	execute(): CommandResult | undefined {
		if (this.clipboardItems.length === 0) return undefined;

		const editor = EditorCore.getInstance();
		this.savedState = editor.sequences.getActiveSequence().tracks;
		this.pastedClips = [];

		const minStart = this.clipboardItems.reduce(
			(earliestStartTime, item) =>
				item.clip.startTime < earliestStartTime
					? item.clip.startTime
					: earliestStartTime,
			this.clipboardItems[0].clip.startTime,
		);

		let updatedTracks = this.savedState;
		const itemsByTrackId = groupClipboardItemsByTrackId({
			clipboardItems: this.clipboardItems,
		});

		for (const [trackId, items] of itemsByTrackId) {
			const clipsToAdd = buildPastedClips({
				items,
				minStart,
				time: this.time,
			});

			if (clipsToAdd.length === 0) {
				continue;
			}

			const trackType = items[0].trackType;
			const sourceTrackIndex = [
				...updatedTracks.overlay,
				updatedTracks.main,
				...updatedTracks.audio,
			].findIndex((track) => track.id === trackId);
			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType,
				timeSpans: clipsToAdd.map((clip) => ({
					startTime: clip.startTime,
					duration: clip.duration,
				})),
				strategy: { type: "aboveSource", sourceTrackIndex },
			});
			if (!placementResult) {
				continue;
			}

			let clipsForPlacement = clipsToAdd;
			if (placementResult.kind === "existingTrack") {
				const targetTrack =
					placementResult.trackIndex < updatedTracks.overlay.length
						? updatedTracks.overlay[placementResult.trackIndex]
						: placementResult.trackIndex === updatedTracks.overlay.length
							? updatedTracks.main
							: updatedTracks.audio[
									placementResult.trackIndex - updatedTracks.overlay.length - 1
								];
				if (targetTrack?.id === updatedTracks.main.id) {
					const earliestClip = clipsToAdd.reduce((earliest, clip) =>
						clip.startTime < earliest.startTime ? clip : earliest,
					);
					const adjustedEarliestStartTime = enforceMainTrackStart({
						tracks: updatedTracks,
						targetTrackId: targetTrack.id,
						requestedStartTime: earliestClip.startTime,
					});
					const delta = subMediaTime({
						a: adjustedEarliestStartTime,
						b: earliestClip.startTime,
					});

					if (delta !== ZERO_MEDIA_TIME) {
						clipsForPlacement = clipsToAdd.map((clip) => ({
							...clip,
							startTime: maxMediaTime({
								a: ZERO_MEDIA_TIME,
								b: addMediaTime({ a: clip.startTime, b: delta }),
							}),
						}));
					}
				}
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				clips: clipsForPlacement,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;

			for (const clip of clipsForPlacement) {
				this.pastedClips.push({
					trackId: applied.targetTrackId,
					clipId: clip.id,
				});
			}
		}

		editor.timeline.updateTracks(updatedTracks);

		if (this.pastedClips.length > 0) {
			return createClipSelectionResult(this.pastedClips);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getPastedClips(): { trackId: string; clipId: string }[] {
		return this.pastedClips;
	}
}

function groupClipboardItemsByTrackId({
	clipboardItems,
}: {
	clipboardItems: ClipClipboardItem[];
}): Map<string, ClipClipboardItem[]> {
	const groupedItems = new Map<string, ClipClipboardItem[]>();

	for (const item of clipboardItems) {
		const existingItems = groupedItems.get(item.trackId) ?? [];
		groupedItems.set(item.trackId, [...existingItems, item]);
	}

	return groupedItems;
}

function buildPastedClips({
	items,
	minStart,
	time,
}: {
	items: ClipClipboardItem[];
	minStart: MediaTime;
	time: MediaTime;
}): TimelineClip[] {
	const clipsToAdd: TimelineClip[] = [];

	for (const item of items) {
		const relativeOffset = subMediaTime({
			a: item.clip.startTime,
			b: minStart,
		});
		const startTime = maxMediaTime({
			a: ZERO_MEDIA_TIME,
			b: addMediaTime({ a: time, b: relativeOffset }),
		});
		const newClipId = generateUUID();

		clipsToAdd.push({
			...item.clip,
			bestTakeMarkerIds: undefined,
			sourceAudioGroupId: undefined,
			id: newClipId,
			startTime,
			animations: cloneAnimations({
				animations: item.clip.animations,
				shouldRegenerateKeyframeIds: true,
			}),
		} as TimelineClip);
	}

	return clipsToAdd;
}
