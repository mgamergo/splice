import type { ProtectedSection } from "@splice/bridge/ops";
import type { TSequence } from "@/timeline";
import {
	mapSourceRangeToSequence,
	RemovalTakeError,
	takeRanges,
} from "@/timeline/markers/removal-takes";
import { mediaTimeFromSeconds } from "@/wasm";

function sectionStarts(sequence: TSequence) {
	const sections = new Map<string, ProtectedSection>(
		sequence.protectedSections?.map((section) => [section.id, section]),
	);
	// Projects saved before section protection was persisted have only removal markers.
	for (const { id, data } of sequence.markers)
		if (data)
			sections.set(id, {
				id,
				sectionName: data.sectionName,
				bestTake: data.bestTake,
			});

	return [...sections.values()].flatMap(({ id, sectionName, bestTake }) => {
		const spans = takeRanges(bestTake).flatMap(
			({ projectItemId, sourceIn, sourceOut }) =>
				mapSourceRangeToSequence({
					tracks: sequence.tracks,
					markerId: id,
					range: {
						item: { id: projectItemId },
						sourceIn: mediaTimeFromSeconds({ seconds: sourceIn }),
						sourceOut: mediaTimeFromSeconds({ seconds: sourceOut }),
					},
				}),
		);
		return spans.length
			? [
					{
						id,
						sectionName,
						start: Math.min(...spans.map(({ start }) => start)),
					},
				]
			: [];
	});
}

/** Check only agent edits. Creator commands can freely change the timeline. */
export function validateProtectedSections({
	before,
	after,
	restructure,
}: {
	before: TSequence;
	after: TSequence;
	restructure?: boolean;
}): void {
	if (restructure) return;
	const previous = sectionStarts(before).sort((a, b) => a.start - b.start);
	if (!previous.length) return;
	const nextStarts = new Map(
		sectionStarts(after).map(({ id, start }) => [id, start]),
	);
	for (const [index, section] of previous.entries()) {
		const start = nextStarts.get(section.id);
		if (start === undefined)
			throw new RemovalTakeError(
				`This cut would remove the whole “${section.sectionName}” section. Keep part of its best take, or pass restructure: true if the creator explicitly asked to remove it.`,
			);
		const reversed = previous
			.slice(0, index)
			.find(
				(earlier) =>
					earlier.start < section.start &&
					(nextStarts.get(earlier.id) ?? start) > start,
			);
		if (reversed)
			throw new RemovalTakeError(
				`This edit puts “${section.sectionName}” before “${reversed.sectionName}”. Keep the teaching order, or pass restructure: true if the creator explicitly asked to change it.`,
			);
	}
}
