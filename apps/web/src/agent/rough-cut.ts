import type { RoughCutRequest } from "@splice/bridge/ops";
import type { ProjectItem } from "@/media/types";
import {
	calculateTotalDuration,
	type RemovalMarker,
	type TSequence,
} from "@/timeline";
import { buildClipFromMedia } from "@/timeline/clip-utils";
import {
	mapTakeToSequence,
	RemovalTakeError,
	resolveTake,
	tagBestTake,
} from "@/timeline/markers/removal-takes";
import { rippleDeleteRanges } from "@/timeline/ripple-delete";
import { buildEmptyTrack } from "@/timeline/placement";
import { buildDefaultSequence } from "@/timeline/sequences";
import { generateUUID } from "@/utils/id";
import {
	addMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
	ZERO_MEDIA_TIME,
} from "@/wasm";

export const RAW_SEQUENCE_NAME = "Raw";

export function buildRawSequence({
	projectItemIds,
	projectItems,
}: {
	projectItemIds: string[];
	projectItems: ProjectItem[];
}): TSequence {
	const sequence = buildDefaultSequence({
		name: RAW_SEQUENCE_NAME,
		isMain: false,
	});
	const audio = buildEmptyTrack({ id: generateUUID(), type: "audio" });
	const seen = new Set<string>();
	let startTime = ZERO_MEDIA_TIME;
	for (const id of projectItemIds) {
		if (seen.has(id))
			throw new RemovalTakeError(
				`Project item ${id} is listed twice in recording order.`,
			);
		seen.add(id);
		const item = projectItems.find((candidate) => candidate.id === id);
		if (
			!item ||
			item.missing ||
			!item.duration ||
			!Number.isFinite(item.duration) ||
			item.duration <= 0 ||
			item.type === "image"
		) {
			throw new RemovalTakeError(
				`Project item ${id} must be an available video or audio recording with a duration.`,
			);
		}
		const duration = mediaTimeFromSeconds({ seconds: item.duration });
		if (duration <= 0)
			throw new RemovalTakeError(
				`Recording ${id} is too short to place on the sequence.`,
			);
		const clip = buildClipFromMedia({
			mediaId: item.id,
			mediaType: item.type,
			name: item.name,
			duration,
			startTime,
		});
		if (clip.type === "video")
			sequence.tracks.main.clips.push({ ...clip, id: generateUUID() });
		if (clip.type === "audio")
			audio.clips.push({ ...clip, id: generateUUID() });
		startTime = addMediaTime({ a: startTime, b: duration });
	}
	if (audio.clips.length) sequence.tracks.audio.push(audio);
	return sequence;
}

export function buildRoughCut({
	source,
	name,
	sections,
	projectItems,
}: {
	source: TSequence;
	name: string;
	sections: RoughCutRequest["sections"];
	projectItems: ProjectItem[];
}) {
	const mapped = sections.map(
		({ name: sectionName, takes, bestTakeIndex }, sectionIndex) => {
			const context = `Section ${sectionIndex + 1} (${sectionName})`;
			const bestTake = takes[bestTakeIndex];
			if (!bestTake)
				throw new RemovalTakeError(
					`${context}: bestTakeIndex ${bestTakeIndex} is outside the takes list.`,
				);
			const windows = takes.map((take, index) => {
				try {
					return {
						...mapTakeToSequence({
							tracks: source.tracks,
							take: resolveTake({ take, projectItems }),
						}),
						description: `${context}, take ${index + 1}`,
						take,
					};
				} catch (error) {
					if (!(error instanceof RemovalTakeError)) throw error;
					throw new RemovalTakeError(
						`${context}, take ${index + 1}: ${error.message}`,
					);
				}
			});
			return {
				sectionName,
				bestTake,
				bestWindow: windows[bestTakeIndex],
				cuts: windows
					.filter((_, index) => index !== bestTakeIndex)
					.sort((a, b) => a.start - b.start),
				windows,
			};
		},
	);

	const windows = mapped
		.flatMap((section) => section.windows)
		.sort((a, b) => a.start - b.start);
	for (let i = 1; i < windows.length; i++) {
		const previous = windows[i - 1];
		const current = windows[i];
		if (previous.end > current.start) {
			throw new RemovalTakeError(
				`${previous.description} overlaps ${current.description}. Give each take a distinct range.`,
			);
		}
	}

	let tracks = source.tracks;
	const markers = [...source.markers];
	const sectionsRemoved = mapped.map(
		({ sectionName, bestTake, bestWindow, cuts }) => {
			const marker: RemovalMarker = {
				id: generateUUID(),
				time: cuts[0].start,
				data: {
					kind: "removal",
					sectionName,
					bestTake,
					badTakes: cuts.map(({ take }) => take),
				},
			};
			markers.push(marker);
			tracks = tagBestTake({
				tracks,
				markerId: marker.id,
				clipIds: bestWindow.clipIds,
			});
			const removed = cuts.reduce(
				(sum, { start, end }) => sum + end - start,
				0,
			);
			return {
				sectionName,
				removedSeconds: mediaTimeToSeconds({
					time: roundMediaTime({ time: removed }),
				}),
			};
		},
	);

	const cut = rippleDeleteRanges({
		tracks,
		markers,
		ranges: mapped.flatMap((section) => section.cuts),
		generateId: generateUUID,
	});
	const sequence: TSequence = {
		...source,
		id: generateUUID(),
		name,
		isMain: false,
		tracks: cut.tracks,
		markers: cut.markers.sort((a, b) => a.time - b.time),
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	return { sequence, sections: sectionsRemoved };
}

export function sequenceDurationSeconds(sequence: TSequence): number {
	return mediaTimeToSeconds({
		time: calculateTotalDuration({ tracks: sequence.tracks }),
	});
}
