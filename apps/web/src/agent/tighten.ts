import type { SourceRange } from "@splice/bridge/ops";

interface Span {
	start: number;
	end: number;
}

/**
 * A cut edge. Padding moves it toward the cut's middle by up to
 * `paddingSeconds`, but never past `limit`, the far side of the silence the
 * edge sits in: breath kept from one silence can't eat the speech beside it.
 * An edge outside any silence has `limit === at` and stays put.
 */
type Edge = { at: number; limit: number };

/**
 * Source-second cuts for pauses, false starts and filler words, one list for
 * all recordings. Pauses keep `paddingSeconds` of breath on each side, up to
 * the whole pause. A false start or filler edge that lies inside a pause snaps
 * to that pause, so the cut follows the audio and keeps the same breath.
 * Overlapping cuts merge.
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
				start: { at: sourceIn, limit: sourceOut },
				end: { at: sourceOut, limit: sourceIn },
			})),
			...[...of(falseStarts), ...of(fillerWords)].map(
				({ sourceIn, sourceOut }) => {
					const before = inside(sourceIn);
					const after = inside(sourceOut);
					return {
						start: before
							? { at: before.sourceIn, limit: before.sourceOut }
							: { at: sourceIn, limit: sourceIn },
						end: after
							? { at: after.sourceOut, limit: after.sourceIn }
							: { at: sourceOut, limit: sourceOut },
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
			// At a shared edge, the padded one wins.
			if (cut.start.at === last.start.at)
				last.start.limit = Math.max(last.start.limit, cut.start.limit);
			if (cut.end.at > last.end.at) last.end = { ...cut.end };
			else if (cut.end.at === last.end.at)
				last.end.limit = Math.min(last.end.limit, cut.end.limit);
		}
		return merged.flatMap(({ start, end }) => {
			const sourceIn = Math.min(start.at + paddingSeconds, start.limit);
			const sourceOut = Math.max(end.at - paddingSeconds, end.limit);
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

/** The parts of `within` outside every span in `without`, sorted and disjoint. */
function subtractSpans({
	within,
	without,
}: {
	within: Span[];
	without: Span[];
}): Span[] {
	const holes = unionSpans(without);
	const kept: Span[] = [];
	let first = 0;
	for (const area of unionSpans(within)) {
		while (first < holes.length && holes[first].end <= area.start) first++;
		let start = area.start;
		for (let i = first; i < holes.length && holes[i].start < area.end; i++) {
			if (holes[i].start > start) kept.push({ start, end: holes[i].start });
			start = Math.max(start, holes[i].end);
		}
		if (area.end > start) kept.push({ start, end: area.end });
	}
	return kept;
}

/** Index of the first of the sorted, disjoint `spans` that ends after `at`. */
function firstEndingAfter({ spans, at }: { spans: Span[]; at: number }) {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (spans[middle].end <= at) low = middle + 1;
		else high = middle;
	}
	return low;
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
	const kept = subtractSpans({ within, without });
	let total = 0;
	let first = 0;
	for (const span of unionSpans(spans)) {
		while (first < kept.length && kept[first].end <= span.start) first++;
		for (let i = first; i < kept.length && kept[i].start < span.end; i++)
			total +=
				Math.min(span.end, kept[i].end) - Math.max(span.start, kept[i].start);
	}
	return total;
}

/**
 * How many groups have some length inside `within` and outside every span in
 * `without`. Sorted once, then one binary search per span.
 */
export function countOverlapping({
	groups,
	within,
	without = [],
}: {
	groups: Span[][];
	within: Span[];
	without?: Span[];
}): number {
	const kept = subtractSpans({ within, without });
	return groups.filter((spans) =>
		spans.some(({ start, end }) => {
			const piece = kept[firstEndingAfter({ spans: kept, at: start })];
			return piece !== undefined && piece.start < end && start < end;
		}),
	).length;
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
	// Cuts come sorted from unionSpans, so one pointer walks the edges.
	let next = 0;
	const widened = unionSpans(cuts).map((cut) => {
		while (next < sorted.length && sorted[next] < cut.start) next++;
		const previous = next > 0 ? sorted[next - 1] : undefined;
		let after = next;
		while (after < sorted.length && sorted[after] <= cut.end) after++;
		const following = sorted[after];
		return {
			...cut,
			start:
				previous !== undefined && cut.start - previous < minimum
					? previous
					: cut.start,
			end:
				following !== undefined && following - cut.end < minimum
					? following
					: cut.end,
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
