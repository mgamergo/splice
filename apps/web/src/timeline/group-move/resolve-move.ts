import type { SequenceTracks } from "@/timeline";
import { getTrackTypeForClipType } from "@/timeline/placement/compatibility";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import type {
	GroupMoveResult,
	MoveGroup,
	PlannedClipMove,
	PlannedTrackCreation,
} from "./types";
import {
	getDisplayTracks,
	getTrackPlacementByDisplayIndex,
	getTrackPlacementById,
} from "./track-placement";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	subMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

type GroupMoveTarget =
	| {
			kind: "existingTrack";
			anchorTargetTrackId: string;
	  }
	| {
			kind: "newTracks";
			anchorInsertIndex: number;
			newTrackIds: string[];
	  };

export function resolveGroupMove({
	group,
	tracks,
	anchorStartTime,
	target,
}: {
	group: MoveGroup;
	tracks: SequenceTracks;
	anchorStartTime: MediaTime;
	target: GroupMoveTarget;
}): GroupMoveResult | null {
	if (target.kind === "newTracks") {
		return resolveNewTrackMove({
			group,
			tracks,
			anchorStartTime,
			anchorInsertIndex: target.anchorInsertIndex,
			newTrackIds: target.newTrackIds,
		});
	}

	return resolveExistingTrackMove({
		group,
		tracks,
		anchorStartTime,
		anchorTargetTrackId: target.anchorTargetTrackId,
	});
}

function resolveExistingTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorTargetTrackId,
}: {
	group: MoveGroup;
	tracks: SequenceTracks;
	anchorStartTime: MediaTime;
	anchorTargetTrackId: string;
}): GroupMoveResult | null {
	const anchorTargetPlacement = getTrackPlacementById({
		tracks,
		trackId: anchorTargetTrackId,
	});
	if (!anchorTargetPlacement) {
		return null;
	}

	const targetTrackIdsByClipId = resolveExistingTrackIdsByClipId({
		group,
		tracks,
		anchorTargetDisplayIndex: anchorTargetPlacement.displayIndex,
	});
	if (!targetTrackIdsByClipId) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByClipId,
	});

	const moves = group.members.map((member) => ({
		sourceTrackId: member.trackId,
		targetTrackId:
			targetTrackIdsByClipId.get(member.clipId) ?? member.trackId,
		clipId: member.clipId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	if (!canApplyMovesToExistingTracks({ tracks, moves })) {
		return null;
	}

	return {
		moves,
		createTracks: [],
		targetSelection: moves.map(({ clipId, targetTrackId }) => ({
			trackId: targetTrackId,
			clipId,
		})),
	};
}

function resolveNewTrackMove({
	group,
	tracks,
	anchorStartTime,
	anchorInsertIndex,
	newTrackIds,
}: {
	group: MoveGroup;
	tracks: SequenceTracks;
	anchorStartTime: MediaTime;
	anchorInsertIndex: number;
	newTrackIds: string[];
}): GroupMoveResult | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.clipId === group.anchor.clipId,
	);
	if (anchorMemberIndex < 0 || newTrackIds.length < sortedMembers.length) {
		return null;
	}

	const hasAudioMember = sortedMembers.some(
		(member) => member.trackSection === "audio",
	);
	const hasNonAudioMember = sortedMembers.some(
		(member) => member.trackSection !== "audio",
	);
	if (hasAudioMember && hasNonAudioMember) {
		return null;
	}

	const clampedAnchorStartTime = clampAnchorStartTime({
		group,
		tracks,
		anchorStartTime,
		targetTrackIdsByClipId: new Map(),
	});
	const blockStartIndex = hasAudioMember
		? clampAudioInsertIndex({
				tracks,
				insertIndex: anchorInsertIndex - anchorMemberIndex,
			})
		: Math.max(
				0,
				Math.min(anchorInsertIndex - anchorMemberIndex, tracks.overlay.length),
			);

	const createTracks: PlannedTrackCreation[] = sortedMembers.map(
		(member, memberIndex) => ({
			id: newTrackIds[memberIndex],
			type: getTrackTypeForClipType({
				clipType: member.clipType,
			}),
			index: blockStartIndex + memberIndex,
		}),
	);
	const moves = sortedMembers.map((member, memberIndex) => ({
		sourceTrackId: member.trackId,
		targetTrackId: newTrackIds[memberIndex],
		clipId: member.clipId,
		newStartTime: addMediaTime({
			a: clampedAnchorStartTime,
			b: member.timeOffset,
		}),
	}));

	return {
		moves,
		createTracks,
		targetSelection: moves.map(({ clipId, targetTrackId }) => ({
			trackId: targetTrackId,
			clipId,
		})),
	};
}

function clampAudioInsertIndex({
	tracks,
	insertIndex,
}: {
	tracks: SequenceTracks;
	insertIndex: number;
}): number {
	const minimumAudioInsertIndex = tracks.overlay.length + 1;
	return Math.max(
		minimumAudioInsertIndex,
		Math.min(insertIndex, minimumAudioInsertIndex + tracks.audio.length),
	);
}

function resolveExistingTrackIdsByClipId({
	group,
	tracks,
	anchorTargetDisplayIndex,
}: {
	group: MoveGroup;
	tracks: SequenceTracks;
	anchorTargetDisplayIndex: number;
}): Map<string, string> | null {
	const sortedMembers = [...group.members].sort(
		(leftMember, rightMember) =>
			leftMember.displayIndex - rightMember.displayIndex,
	);
	const anchorMemberIndex = sortedMembers.findIndex(
		(member) => member.clipId === group.anchor.clipId,
	);
	if (anchorMemberIndex < 0) {
		return null;
	}

	const targetTrackIdsByClipId = new Map<string, string>();
	const usedTrackIds = new Set<string>();
	const anchorPlacement = getTrackPlacementByDisplayIndex({
		tracks,
		displayIndex: anchorTargetDisplayIndex,
	});
	if (!anchorPlacement) {
		return null;
	}

	targetTrackIdsByClipId.set(
		group.anchor.clipId,
		anchorPlacement.trackId,
	);
	usedTrackIds.add(anchorPlacement.trackId);

	let upperBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex - 1;
		memberIndex >= 0;
		memberIndex -= 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForClipType({
				clipType: member.clipType,
			}),
			startDisplayIndex: upperBoundaryIndex - 1,
			step: -1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			return null;
		}

		targetTrackIdsByClipId.set(member.clipId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		upperBoundaryIndex = targetPlacement.displayIndex;
	}

	let lowerBoundaryIndex = anchorTargetDisplayIndex;
	for (
		let memberIndex = anchorMemberIndex + 1;
		memberIndex < sortedMembers.length;
		memberIndex += 1
	) {
		const member = sortedMembers[memberIndex];
		const targetPlacement = findCompatibleTrackPlacement({
			tracks,
			requiredTrackType: getTrackTypeForClipType({
				clipType: member.clipType,
			}),
			startDisplayIndex: lowerBoundaryIndex + 1,
			step: 1,
			usedTrackIds,
		});
		if (!targetPlacement) {
			return null;
		}

		targetTrackIdsByClipId.set(member.clipId, targetPlacement.trackId);
		usedTrackIds.add(targetPlacement.trackId);
		lowerBoundaryIndex = targetPlacement.displayIndex;
	}

	return targetTrackIdsByClipId;
}

function findCompatibleTrackPlacement({
	tracks,
	requiredTrackType,
	startDisplayIndex,
	step,
	usedTrackIds,
}: {
	tracks: SequenceTracks;
	requiredTrackType: ReturnType<typeof getTrackTypeForClipType>;
	startDisplayIndex: number;
	step: -1 | 1;
	usedTrackIds: Set<string>;
}) {
	for (
		let displayIndex = startDisplayIndex;
		displayIndex >= 0 &&
		displayIndex < tracks.overlay.length + 1 + tracks.audio.length;
		displayIndex += step
	) {
		const placement = getTrackPlacementByDisplayIndex({
			tracks,
			displayIndex,
		});
		if (!placement) {
			continue;
		}

		if (
			placement.trackType === requiredTrackType &&
			!usedTrackIds.has(placement.trackId)
		) {
			return placement;
		}
	}

	return null;
}

function clampAnchorStartTime({
	group,
	tracks,
	anchorStartTime,
	targetTrackIdsByClipId,
}: {
	group: MoveGroup;
	tracks: SequenceTracks;
	anchorStartTime: MediaTime;
	targetTrackIdsByClipId: Map<string, string>;
}): MediaTime {
	const minimumAnchorStartTime = group.members.reduce(
		(minimumStartTime, member) =>
			member.timeOffset < ZERO_MEDIA_TIME
				? maxMediaTime({
						a: minimumStartTime,
						b: subMediaTime({
							a: ZERO_MEDIA_TIME,
							b: member.timeOffset,
						}),
					})
				: minimumStartTime,
		ZERO_MEDIA_TIME,
	);
	let clampedAnchorStartTime =
		anchorStartTime < minimumAnchorStartTime
			? minimumAnchorStartTime
			: anchorStartTime;

	const memberOnMainTrack = group.members.find(
		(member) =>
			targetTrackIdsByClipId.get(member.clipId) === tracks.main.id,
	);
	if (!memberOnMainTrack) {
		return clampedAnchorStartTime;
	}

	const movingClipIds = new Set(
		group.members.map((member) => member.clipId),
	);
	const requestedMainStartTime = addMediaTime({
		a: clampedAnchorStartTime,
		b: memberOnMainTrack.timeOffset,
	});
	const earliestStationaryMainStartTime = tracks.main.clips
		.filter((clip) => !movingClipIds.has(clip.id))
		.reduce<MediaTime | null>((earliestStartTime, clip) => {
			if (earliestStartTime == null || clip.startTime < earliestStartTime) {
				return clip.startTime;
			}

			return earliestStartTime;
		}, null);
	if (
		earliestStationaryMainStartTime == null ||
		requestedMainStartTime <= earliestStationaryMainStartTime
	) {
		clampedAnchorStartTime = maxMediaTime({
			a: minimumAnchorStartTime,
			b: subMediaTime({
				a: ZERO_MEDIA_TIME,
				b: memberOnMainTrack.timeOffset,
			}),
		});
	}

	return clampedAnchorStartTime;
}

function canApplyMovesToExistingTracks({
	tracks,
	moves,
}: {
	tracks: SequenceTracks;
	moves: PlannedClipMove[];
}): boolean {
	const movingClipIds = new Set(moves.map((move) => move.clipId));
	const sourceClips = new Map(
		getDisplayTracks({ tracks }).flatMap((track) =>
			track.clips.map((clip) => [clip.id, clip] as const),
		),
	);
	const movesByTargetTrackId = new Map<string, PlannedClipMove[]>();
	for (const move of moves) {
		const targetMoves = movesByTargetTrackId.get(move.targetTrackId) ?? [];
		targetMoves.push(move);
		movesByTargetTrackId.set(move.targetTrackId, targetMoves);
	}

	for (const [targetTrackId, targetMoves] of movesByTargetTrackId) {
		const targetPlacement = getTrackPlacementById({
			tracks,
			trackId: targetTrackId,
		});
		if (!targetPlacement) {
			return false;
		}

		const targetTrack = getDisplayTracks({ tracks })[
			targetPlacement.displayIndex
		];
		if (!targetTrack) {
			return false;
		}

		const timeSpans = targetMoves.map((move) => {
			const sourceClip = sourceClips.get(move.clipId);
			return {
				startTime: move.newStartTime,
				duration: sourceClip?.duration ?? ZERO_MEDIA_TIME,
			};
		});
		if (hasOverlappingTimeSpans({ timeSpans })) {
			return false;
		}

		if (
			!canPlaceTimeSpansOnTrack({
				track: {
					clips: targetTrack.clips.filter(
						(clip) => !movingClipIds.has(clip.id),
					),
				},
				timeSpans,
			})
		) {
			return false;
		}
	}

	return true;
}

function hasOverlappingTimeSpans({
	timeSpans,
}: {
	timeSpans: Array<{ startTime: number; duration: number }>;
}): boolean {
	const sortedSpans = [...timeSpans].sort(
		(leftSpan, rightSpan) => leftSpan.startTime - rightSpan.startTime,
	);

	for (let spanIndex = 1; spanIndex < sortedSpans.length; spanIndex += 1) {
		const previousSpan = sortedSpans[spanIndex - 1];
		const currentSpan = sortedSpans[spanIndex];
		if (
			previousSpan.startTime + previousSpan.duration >
			currentSpan.startTime
		) {
			return true;
		}
	}

	return false;
}
