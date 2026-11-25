/**
 * What changed between an approved checkpoint and the current edit. Clips are
 * compared by what they play, not by id, so a razor that changes nothing and
 * later clips shifting after a ripple delete aren't changes.
 */
import type { ChangedPassage, CheckpointChange } from "@splice/bridge/approval";
import type { TBackground } from "@/project/types";
import type {
	Marker,
	SequenceTracks,
	TimelineClip,
	TimelineTrack,
} from "@/timeline/types";
import { calculateTotalDuration } from "@/timeline";
import { type MediaTime, mediaTimeToSeconds } from "@/wasm";

/** Times closer than this are the same; about a third of a frame at 30 fps. */
const EPSILON = 0.01;
/** Changes closer together than this play as one passage. */
const PASSAGE_GAP_SECONDS = 1;

/** The parts of an edit a comparison reads. Cue times are sequence seconds. */
export interface ComparableEdit {
	tracks: SequenceTracks;
	markers: Marker[];
	background?: TBackground;
	cues: Array<{ start: number; end: number; text: string }>;
}

export interface CheckpointComparison {
	identical: boolean;
	changes: CheckpointChange[];
	passages: ChangedPassage[];
}

/** JSON with sorted keys, so equal values always give equal text. */
export function stableStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, inner: unknown) =>
			inner && typeof inner === "object" && !Array.isArray(inner)
				? Object.fromEntries(
						Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
					)
				: inner,
		) ?? ""
	);
}

/** A short, stable hash of some text (FNV-1a, twice with different seeds). */
export function hashText(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ text.length;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		a = Math.imul(a ^ code, 0x01000193);
		b = Math.imul(b ^ code, 0x5bd1e995);
	}
	return [a, b]
		.map((part) => (part >>> 0).toString(16).padStart(8, "0"))
		.join("");
}

/** A run of the track that plays one stretch of one source without a break. */
interface Run {
	start: number;
	end: number;
	key: string;
	sourceStart: number;
	sourceEnd: number;
}

const seconds = (time: MediaTime) => mediaTimeToSeconds({ time });

/** What a clip shows or plays, apart from where it sits and which stretch. */
function clipKey(clip: TimelineClip): string {
	const {
		id: _id,
		name: _name,
		startTime: _startTime,
		duration: _duration,
		trimStart: _trimStart,
		trimEnd: _trimEnd,
		sourceDuration: _sourceDuration,
		bestTakeMarkerIds: _bestTakeMarkerIds,
		sourceAudioGroupId: _sourceAudioGroupId,
		...rest
	} = clip;
	return stableStringify(
		Object.fromEntries(
			Object.entries(rest).filter(([key]) => key !== "buffer"),
		),
	);
}

function clipRate(clip: TimelineClip): number {
	return "retime" in clip && clip.retime ? clip.retime.rate : 1;
}

/** The track's clips in order, with clips a razor split joined back up. */
function trackRuns({
	track,
	stack,
}: {
	track: TimelineTrack;
	stack: number;
}): Run[] {
	const runs: Run[] = [];
	const clips = [...track.clips].sort((a, b) => a.startTime - b.startTime);
	for (const clip of clips) {
		const start = seconds(clip.startTime);
		const end = start + seconds(clip.duration);
		const sourceStart = seconds(clip.trimStart);
		const sourceEnd = sourceStart + seconds(clip.duration) * clipRate(clip);
		const key = stableStringify([
			clipKey(clip),
			"hidden" in track && track.hidden,
			"muted" in track && track.muted,
			stack,
		]);
		const previous = runs.at(-1);
		if (
			previous &&
			previous.key === key &&
			Math.abs(previous.end - start) < EPSILON &&
			Math.abs(previous.sourceEnd - sourceStart) < EPSILON
		) {
			previous.end = end;
			previous.sourceEnd = sourceEnd;
			continue;
		}
		runs.push({ start, end, key, sourceStart, sourceEnd });
	}
	return runs;
}

function sameRun({ a, b }: { a: Run; b: Run }): boolean {
	return (
		a.key === b.key &&
		Math.abs(a.sourceStart - b.sourceStart) < EPSILON &&
		Math.abs(a.sourceEnd - b.sourceEnd) < EPSILON
	);
}

/**
 * The longest common subsequence of two lists, as index pairs in order. The
 * common start and end are matched first, so a few edits to a long list cost
 * little.
 */
export function alignLists<T>({
	before,
	after,
	equals,
}: {
	before: T[];
	after: T[];
	equals: (a: T, b: T) => boolean;
}): Array<[number, number]> {
	let head = 0;
	while (
		head < before.length &&
		head < after.length &&
		equals(before[head], after[head])
	)
		head++;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		equals(before[before.length - 1 - tail], after[after.length - 1 - tail])
	)
		tail++;
	const pairs: Array<[number, number]> = [];
	for (let index = 0; index < head; index++) pairs.push([index, index]);
	const a = before.slice(head, before.length - tail);
	const b = after.slice(head, after.length - tail);
	// A major recut can leave thousands of unmatched cues. Report that span
	// as one unmatched stretch when exact alignment would stall the editor.
	if (a.length > 0 && b.length > 0 && a.length * b.length <= 1_000_000) {
		const width = b.length + 1;
		const lengths = new Uint32Array((a.length + 1) * width);
		for (let i = a.length - 1; i >= 0; i--)
			for (let j = b.length - 1; j >= 0; j--)
				lengths[i * width + j] = equals(a[i], b[j])
					? lengths[(i + 1) * width + j + 1] + 1
					: Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
		for (let i = 0, j = 0; i < a.length && j < b.length; ) {
			if (equals(a[i], b[j])) {
				pairs.push([head + i, head + j]);
				i++;
				j++;
			} else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
				i++;
			else j++;
		}
	}
	for (let index = 0; index < tail; index++)
		pairs.push([before.length - tail + index, after.length - tail + index]);
	return pairs;
}

/** Calls `visit` for each stretch between matched pairs, with what is unmatched there. */
function eachGap<T>({
	before,
	after,
	pairs,
	visit,
}: {
	before: T[];
	after: T[];
	pairs: Array<[number, number]>;
	visit: (gap: {
		removed: T[];
		added: T[];
		/** The matched pair before the stretch, if any. */
		previous?: [T, T];
		/** The matched pair after it, if any. */
		next?: [T, T];
	}) => void;
}) {
	let i = 0;
	let j = 0;
	let previous: [T, T] | undefined;
	for (const [bi, ai] of [...pairs, [before.length, after.length]]) {
		const next: [T, T] | undefined =
			bi < before.length ? [before[bi], after[ai]] : undefined;
		visit({
			removed: before.slice(i, bi),
			added: after.slice(j, ai),
			previous,
			next,
		});
		previous = next;
		i = bi + 1;
		j = ai + 1;
	}
}

function allTracks(tracks: SequenceTracks): TimelineTrack[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

function trackLabel({
	track,
	tracks,
}: {
	track: TimelineTrack;
	tracks: TimelineTrack[];
}) {
	const sameType = tracks.filter(({ type }) => type === track.type);
	return track.name || `${track.type} ${sameType.indexOf(track) + 1}`;
}

/** Pairs each approved track with the current one: by id, then by type and order. */
function pairTracks({
	approved,
	current,
}: {
	approved: TimelineTrack[];
	current: TimelineTrack[];
}): Array<[TimelineTrack | undefined, TimelineTrack | undefined]> {
	const pairs: Array<[TimelineTrack | undefined, TimelineTrack | undefined]> =
		[];
	const unclaimed = new Set(current);
	const leftover: TimelineTrack[] = [];
	for (const track of approved) {
		const match = current.find(
			(candidate) => candidate.id === track.id && unclaimed.has(candidate),
		);
		if (match) {
			unclaimed.delete(match);
			pairs.push([track, match]);
		} else leftover.push(track);
	}
	for (const track of leftover) {
		const match = [...unclaimed].find(({ type }) => type === track.type);
		if (match) unclaimed.delete(match);
		pairs.push([track, match]);
	}
	for (const track of unclaimed) pairs.push([undefined, track]);
	return pairs;
}

/** Maps a time on the approved edit to the current one, through the main track's matched runs. */
type TimeMap = (approvedSeconds: number) => number;

function trackChanges({
	approved,
	current,
	label,
}: {
	approved: Run[];
	current: Run[];
	label: string;
}): { changes: CheckpointChange[]; matched: Array<[Run, Run]> } {
	const pairs = alignLists({
		before: approved,
		after: current,
		equals: (a, b) => sameRun({ a, b }),
	});
	const changes: CheckpointChange[] = [];
	eachGap({
		before: approved,
		after: current,
		pairs,
		visit: ({ removed, added, previous, next }) => {
			const anchor = previous ? previous[1].end : (next?.[1].start ?? 0);
			const approvedAnchor = previous
				? previous[0].end
				: (next?.[0].start ?? 0);
			const unpaired = [...added];
			for (const run of removed) {
				// A run that still plays part of the same source was trimmed or retimed.
				const index = unpaired.findIndex(
					(candidate) =>
						candidate.key === run.key &&
						candidate.sourceStart < run.sourceEnd &&
						run.sourceStart < candidate.sourceEnd,
				);
				if (index >= 0) {
					const [match] = unpaired.splice(index, 1);
					changes.push({
						kind: "changed",
						evidence: hashText(stableStringify([run, match])),
						what: "clip",
						label,
						start: match.start,
						end: match.end,
						approvedStart: run.start,
						approvedEnd: run.end,
					});
					continue;
				}
				changes.push({
					kind: "removed",
					evidence: hashText(stableStringify(run)),
					what: "clip",
					label,
					start: anchor,
					end: anchor,
					approvedStart: run.start,
					approvedEnd: run.end,
				});
			}
			for (const run of unpaired)
				changes.push({
					kind: "added",
					evidence: hashText(stableStringify(run)),
					what: "clip",
					label,
					start: run.start,
					end: run.end,
					approvedStart: approvedAnchor,
					approvedEnd: approvedAnchor,
				});
			// Nothing else changed here, yet the space before the next run did.
			if (removed.length === 0 && added.length === 0 && next) {
				const gap = previous ? next[1].start - previous[1].end : next[1].start;
				const approvedGap = previous
					? next[0].start - previous[0].end
					: next[0].start;
				if (Math.abs(gap - approvedGap) >= EPSILON)
					changes.push({
						kind: "gap",
						evidence: hashText(stableStringify([approvedGap, gap, next])),
						what: "clip",
						label,
						start: previous ? previous[1].end : 0,
						end: next[1].start,
						approvedStart: previous ? previous[0].end : 0,
						approvedEnd: next[0].start,
					});
			}
		},
	});
	return {
		changes,
		matched: pairs.map(([a, b]) => [approved[a], current[b]]),
	};
}

function timeMap(matched: Array<[Run, Run]>): TimeMap {
	return (time) => {
		let previous: [Run, Run] | undefined;
		for (const [approved, current] of matched) {
			if (time < approved.start - EPSILON) {
				const before = previous?.[0].end ?? 0;
				const after = previous?.[1].end ?? 0;
				const fraction = (time - before) / (approved.start - before);
				return Math.max(0, after + fraction * (current.start - after));
			}
			if (time < approved.end)
				return Math.max(0, time + current.start - approved.start);
			previous = [approved, current];
		}
		return previous ? time + previous[1].end - previous[0].end : time;
	};
}

function markerKey(marker: Marker): string {
	const { time: _time, ...rest } = marker;
	return stableStringify(rest);
}

function markerChanges({
	approved,
	current,
	toCurrent,
}: {
	approved: Marker[];
	current: Marker[];
	toCurrent: TimeMap;
}): CheckpointChange[] {
	const changes: CheckpointChange[] = [];
	const span = (marker: Marker) => {
		const start = seconds(marker.time);
		return {
			start,
			end: start + (marker.duration ? seconds(marker.duration) : 0),
		};
	};
	const label = (marker: Marker) =>
		marker.data
			? `Removal marker: ${marker.data.sectionName}`
			: marker.note || "Marker";
	const unmatched = [...current];
	for (const marker of approved) {
		const index = unmatched.findIndex((candidate) =>
			marker.id
				? candidate.id === marker.id
				: !candidate.data &&
					(markerKey(candidate) === markerKey(marker) ||
						Math.abs(
							seconds(candidate.time) - toCurrent(seconds(marker.time)),
						) < EPSILON),
		);
		const was = span(marker);
		if (index < 0) {
			const at = toCurrent(was.start);
			changes.push({
				kind: "removed",
				evidence: hashText(stableStringify(marker)),
				what: "marker",
				label: label(marker),
				start: at,
				end: at,
				approvedStart: was.start,
				approvedEnd: was.end,
			});
			continue;
		}
		const [match] = unmatched.splice(index, 1);
		// A take swap or restore changes the stored takes; the clips show the move.
		if (
			markerKey(match) !== markerKey(marker) ||
			Math.abs(seconds(match.time) - toCurrent(was.start)) >= EPSILON
		)
			changes.push({
				kind: "changed",
				evidence: hashText(stableStringify([marker, match])),
				what: "marker",
				label: label(match),
				...span(match),
				approvedStart: was.start,
				approvedEnd: was.end,
			});
	}
	for (const marker of unmatched) {
		const now = span(marker);
		changes.push({
			kind: "added",
			evidence: hashText(stableStringify(marker)),
			what: "marker",
			label: label(marker),
			...now,
			approvedStart: now.start,
			approvedEnd: now.start,
		});
	}
	return changes;
}

function cueLabel(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

function cueChanges({
	approved,
	current,
	toCurrent,
	duration,
}: {
	approved: ComparableEdit["cues"];
	current: ComparableEdit["cues"];
	toCurrent: TimeMap;
	duration: number;
}): CheckpointChange[] {
	const before = approved.filter(({ text }) => text);
	const after = current.filter(({ text }) => text);
	const pairs = alignLists({
		before,
		after,
		equals: (a, b) => a.text.trim() === b.text.trim(),
	});
	const changes: CheckpointChange[] = [];
	for (const [a, b] of pairs) {
		const was = before[a];
		const now = after[b];
		if (
			Math.abs(toCurrent(was.start) - now.start) < EPSILON &&
			Math.abs(was.end - was.start - (now.end - now.start)) < EPSILON
		)
			continue;
		changes.push({
			kind: "changed",
			what: "caption",
			label: cueLabel(now.text),
			evidence: hashText(stableStringify([was, now])),
			start: now.start,
			end: now.end,
			approvedStart: was.start,
			approvedEnd: was.end,
		});
	}
	eachGap({
		before,
		after,
		pairs,
		visit: ({ removed, added, previous, next }) => {
			const approvedAnchor = previous?.[0].end ?? next?.[0].start ?? 0;
			const count = Math.max(removed.length, added.length);
			for (let index = 0; index < count; index++) {
				const was = removed[index];
				const now = added[index];
				changes.push({
					kind: was && now ? "changed" : was ? "removed" : "added",
					evidence: hashText(stableStringify([was, now])),
					what: "caption",
					label: cueLabel((now ?? was).text),
					start: now?.start ?? Math.min(duration, toCurrent(was.start)),
					end: now?.end ?? Math.min(duration, toCurrent(was.start)),
					approvedStart: was?.start ?? approvedAnchor,
					approvedEnd: was?.end ?? approvedAnchor,
				});
			}
		},
	});
	return changes;
}

/** Groups changes that lie within a second of each other on the current edit. */
export function groupPassages(changes: CheckpointChange[]): ChangedPassage[] {
	const sorted = [...changes].sort(
		(a, b) => a.start - b.start || a.approvedStart - b.approvedStart,
	);
	const passages: ChangedPassage[] = [];
	for (const change of sorted) {
		const last = passages.at(-1);
		if (last && change.start <= last.end + PASSAGE_GAP_SECONDS) {
			last.end = Math.max(last.end, change.end);
			last.approvedStart = Math.min(last.approvedStart, change.approvedStart);
			last.approvedEnd = Math.max(last.approvedEnd, change.approvedEnd);
			last.changes.push(change);
			continue;
		}
		passages.push({
			start: change.start,
			end: change.end,
			approvedStart: change.approvedStart,
			approvedEnd: change.approvedEnd,
			changes: [change],
		});
	}
	return passages;
}

export function compareEdits({
	approved,
	current,
}: {
	approved: ComparableEdit;
	current: ComparableEdit;
}): CheckpointComparison {
	const approvedTracks = allTracks(approved.tracks);
	const currentTracks = allTracks(current.tracks);
	const changes: CheckpointChange[] = [];
	let mainMatches: Array<[Run, Run]> = [];
	for (const [before, after] of pairTracks({
		approved: approvedTracks,
		current: currentTracks,
	})) {
		const track = after ?? before;
		if (!track) continue;
		const label = after
			? trackLabel({ track: after, tracks: currentTracks })
			: trackLabel({ track, tracks: approvedTracks });
		const result = trackChanges({
			approved: before
				? trackRuns({
						track: before,
						stack: approved.tracks.overlay.findIndex(
							({ id }) => id === before.id,
						),
					})
				: [],
			current: after
				? trackRuns({
						track: after,
						stack: current.tracks.overlay.findIndex(
							({ id }) => id === after.id,
						),
					})
				: [],
			label,
		});
		changes.push(...result.changes);
		if (before === approved.tracks.main) mainMatches = result.matched;
	}
	const toCurrent = timeMap(mainMatches);
	changes.push(
		...markerChanges({
			approved: approved.markers,
			current: current.markers,
			toCurrent,
		}),
		...cueChanges({
			approved: approved.cues,
			current: current.cues,
			toCurrent,
			duration: seconds(calculateTotalDuration({ tracks: current.tracks })),
		}),
	);
	if (
		stableStringify(approved.background) !== stableStringify(current.background)
	)
		changes.push({
			kind: "changed",
			what: "background",
			label: "Project background",
			evidence: hashText(
				stableStringify([approved.background, current.background]),
			),
			start: 0,
			end: 0,
			approvedStart: 0,
			approvedEnd: 0,
		});
	return {
		identical: changes.length === 0,
		changes,
		passages: groupPassages(changes),
	};
}

/** "2 clip changes, 1 caption change" for a passage or a whole comparison. */
export function describeChanges(changes: CheckpointChange[]): string {
	const counts = new Map<CheckpointChange["what"], number>();
	for (const { what } of changes) counts.set(what, (counts.get(what) ?? 0) + 1);
	return [...counts]
		.map(([what, count]) => `${count} ${what} change${count === 1 ? "" : "s"}`)
		.join(", ");
}
