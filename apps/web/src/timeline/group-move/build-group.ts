import type { ClipRef, SequenceTracks } from "@/timeline";
import { findTrackInSequenceTracks } from "@/timeline/track-clip-update";
import type { GroupMember, MoveGroup } from "./types";
import { getTrackPlacementById } from "./track-placement";
import { subMediaTime } from "@/wasm";

export function buildMoveGroup({
	anchorRef,
	selectedClips,
	tracks,
}: {
	anchorRef: ClipRef;
	selectedClips: ClipRef[];
	tracks: SequenceTracks;
}): MoveGroup | null {
	const anchorTrack = findTrackInSequenceTracks({
		tracks,
		trackId: anchorRef.trackId,
	});
	const anchorClip = anchorTrack?.clips.find(
		(clip) => clip.id === anchorRef.clipId,
	);
	const anchorPlacement = getTrackPlacementById({
		tracks,
		trackId: anchorRef.trackId,
	});
	if (!anchorTrack || !anchorClip || !anchorPlacement) {
		return null;
	}

	const seen = new Set<string>();
	const orderedRefs = [anchorRef, ...selectedClips].filter((clipRef) => {
		if (seen.has(clipRef.clipId)) {
			return false;
		}

		seen.add(clipRef.clipId);
		return true;
	});

	const members = orderedRefs.flatMap((clipRef): GroupMember[] => {
		const track = findTrackInSequenceTracks({
			tracks,
			trackId: clipRef.trackId,
		});
		const clip = track?.clips.find(
			(trackClip) => trackClip.id === clipRef.clipId,
		);
		const placement = getTrackPlacementById({
			tracks,
			trackId: clipRef.trackId,
		});
		if (!track || !clip || !placement) {
			return [];
		}

		return [
			{
				trackId: track.id,
				clipId: clip.id,
				clipType: clip.type,
				duration: clip.duration,
				timeOffset: subMediaTime({
					a: clip.startTime,
					b: anchorClip.startTime,
				}),
				trackSection: placement.section,
				sectionIndex: placement.sectionIndex,
				displayIndex: placement.displayIndex,
			},
		];
	});

	if (members.length === 0) {
		return null;
	}

	const anchor = members.find(
		(member) =>
			member.trackId === anchorRef.trackId &&
			member.clipId === anchorRef.clipId,
	);
	if (!anchor) {
		return null;
	}

	return {
		anchor,
		members,
	};
}
