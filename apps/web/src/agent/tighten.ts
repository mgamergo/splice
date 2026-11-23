import type { SourceRange } from "@splice/bridge/ops";

interface Span {
	start: number;
	end: number;
}

type Edge = { at: number; padded: boolean };

/**
 * Source-second cuts for pauses, false starts and filler words, one list for
 * all recordings. Pauses keep `paddingSeconds` of breath on each side. A false
 * start or filler edge that lies inside a pause snaps to that pause, so the
 * cut follows the audio and keeps the same breath. Overlapping cuts merge.
 */
export function planTightenCuts({
	pauses,
	falseStarts,
	fillerWords,
	paddingSeconds,
}: {
	pauses: SourceRange[];
	falseStarts: SourceRange[];
	fillerWords: SourceRange[];
	paddingSeconds: number;
}): SourceRange[] {
	const itemIds = new Set(
		[...pauses, ...falseStarts, ...fillerWords].map(
			({ projectItemId }) => projectItemId,
		),
	);
	return [...itemIds].flatMap((projectItemId) => {
		const of = (ranges: SourceRange[]) =>
			ranges.filter((range) => range.projectItemId === projectItemId);
		const silences = of(pauses);
		const inside = (at: number) =>
			silences.find(
				({ sourceIn, sourceOut }) => sourceIn <= at && at <= sourceOut,
			);
		const cuts: Array<{ start: Edge; end: Edge }> = [
			...silences.map(({ sourceIn, sourceOut }) => ({
				start: { at: sourceIn, padded: true },
				end: { at: sourceOut, padded: true },
			})),
			...[...of(falseStarts), ...of(fillerWords)].map(
				({ sourceIn, sourceOut }) => {
					const before = inside(sourceIn);
					const after = inside(sourceOut);
					return {
						start: before
							? { at: before.sourceIn, padded: true }
							: { at: sourceIn, padded: false },
						end: after
							? { at: after.sourceOut, padded: true }
							: { at: sourceOut, padded: false },
					};
				},
			),
		].sort((a, b) => a.start.at - b.start.at);

		const merged: typeof cuts = [];
		for (const cut of cuts) {
			const last = merged.at(-1);
			if (!last || cut.start.at > last.end.at) {
				merged.push({ start: { ...cut.start }, end: { ...cut.end } });
				continue;
			}
			if (cut.start.at === last.start.at)
				last.start.padded ||= cut.start.padded;
			if (cut.end.at > last.end.at) last.end = { ...cut.end };
			else if (cut.end.at === last.end.at) last.end.padded ||= cut.end.padded;
		}
		return merged.flatMap(({ start, end }) => {
			const sourceIn = start.at + (start.padded ? paddingSeconds : 0);
			const sourceOut = end.at - (end.padded ? paddingSeconds : 0);
			return sourceOut - sourceIn > 0.001
				? [{ projectItemId, sourceIn, sourceOut }]
				: [];
		});
	});
}

/** Sorted, non-overlapping spans with touching ones joined. */
export function unionSpans<T extends Span>(spans: T[]): T[] {
	const merged: T[] = [];
	for (const span of [...spans].sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last && span.start <= last.end) {
			if (span.end > last.end) last.end = span.end;
		} else if (span.end > span.start) {
			merged.push({ ...span });
		}
	}
	return merged;
}

/** Total length of `spans` that lies inside `within` and outside every span in `without`. */
export function measureSpans({
	spans,
	within,
	without = [],
}: {
	spans: Span[];
	within: Span[];
	without?: Span[];
}): number {
	const kept = unionSpans(within);
	const excluded = unionSpans(without);
	let total = 0;
	for (const span of unionSpans(spans)) {
		for (const area of kept) {
			let start = Math.max(span.start, area.start);
			const end = Math.min(span.end, area.end);
			if (end <= start) continue;
			for (const hole of excluded) {
				if (hole.end <= start || hole.start >= end) continue;
				total += Math.max(0, hole.start - start);
				start = Math.max(start, hole.end);
			}
			total += Math.max(0, end - start);
		}
	}
	return total;
}

/**
 * Widens cuts over the slivers they would leave: any piece of a clip, or any
 * gap between two cuts, shorter than `minimum`. `edges` are the clip
 * boundaries on every track.
 */
export function closeSlivers<T extends Span>({
	cuts,
	edges,
	minimum,
}: {
	cuts: T[];
	edges: Array<T["start"]>;
	minimum: number;
}): T[] {
	const sorted = [...new Set(edges)].sort((a, b) => a - b);
	const widened = unionSpans(cuts).map((cut) => {
		const previous = sorted.findLast((edge) => edge < cut.start);
		const next = sorted.find((edge) => edge > cut.end);
		return {
			...cut,
			start:
				previous !== undefined && cut.start - previous < minimum
					? previous
					: cut.start,
			end: next !== undefined && next - cut.end < minimum ? next : cut.end,
		};
	});
	const closed: T[] = [];
	for (const cut of unionSpans(widened)) {
		const last = closed.at(-1);
		if (last && cut.start - last.end < minimum) last.end = cut.end;
		else closed.push(cut);
	}
	return closed;
}
