/**
 * Review issues: what the creator should look at before exporting. Each has
 * an evidence hash; a dismissal holds only while the evidence still matches.
 */
import type { Dismissal, ReviewIssue } from "@splice/bridge/approval";
import type { ProjectCaptions } from "@splice/bridge/delivery";
import { audibleClips } from "@/agent/loudness";
import { MAX_LINE_CHARS, wrapCueText } from "@/captions/cues";
import type { ProjectItem } from "@/media/types";
import { takeRanges } from "@/timeline/markers/removal-takes";
import type { SequenceTracks, TimelineClip, TSequence } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";
import {
	type CheckpointComparison,
	describeChanges,
	hashText,
	stableStringify,
} from "./compare";
import type { CaptionCue } from "@/captions/cues";
import type { ApprovedCheckpoint } from "./types";

/** Faster than this, few viewers can read a cue; YouTube suggests about 20. */
export const MAX_CHARS_PER_SECOND = 25;
const MAX_CUE_CHARS = 2 * MAX_LINE_CHARS;
/** A plain marker whose note starts like this is flagged for review. */
const FLAG_NOTE = /^\s*(review|flag|todo|fixme)\b/i;
/** A stored take overlapping the cut by this much plays twice. */
const DUPLICATE_SECONDS = 0.5;

function allClips(tracks: SequenceTracks): TimelineClip[] {
	return [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap(
		(track): TimelineClip[] => track.clips,
	);
}

function clipSpan(clip: TimelineClip) {
	const start = mediaTimeToSeconds({ time: clip.startTime });
	return { start, end: start + mediaTimeToSeconds({ time: clip.duration }) };
}

/** Seconds of `projectItemId`'s source between `sourceIn` and `sourceOut` that the clips play. */
function playedSeconds({
	clips,
	projectItemId,
	sourceIn,
	sourceOut,
}: {
	clips: TimelineClip[];
	projectItemId: string;
	sourceIn: number;
	sourceOut: number;
}): { seconds: number; at?: number } {
	let total = 0;
	let at: number | undefined;
	for (const clip of clips) {
		if (!("mediaId" in clip) || clip.mediaId !== projectItemId) continue;
		const rate = "retime" in clip && clip.retime ? clip.retime.rate : 1;
		const from = mediaTimeToSeconds({ time: clip.trimStart });
		const to = from + mediaTimeToSeconds({ time: clip.duration }) * rate;
		const overlap = Math.min(to, sourceOut) - Math.max(from, sourceIn);
		if (overlap <= 0) continue;
		total += overlap;
		at ??= clipSpan(clip).start + Math.max(0, sourceIn - from) / rate;
	}
	return { seconds: total, at };
}

function changedPassageIssues({
	comparison,
	checkpoint,
}: {
	comparison: CheckpointComparison;
	checkpoint: ApprovedCheckpoint;
}): ReviewIssue[] {
	return comparison.passages.map((passage) => {
		const identity = hashText(
			stableStringify(passage.changes.map(({ evidence }) => evidence)),
		);
		return {
			id: `changed:${checkpoint.id}:${identity}`,
			kind: "changed-since-approval" as const,
			title: "Changed since approval",
			detail: `${describeChanges(passage.changes)}: ${[
				...new Set(passage.changes.map(({ label }) => label)),
			]
				.slice(0, 3)
				.join("; ")}`,
			start: passage.start,
			end: passage.end,
			evidence: identity,
		};
	});
}

function footageIssues({
	sequence,
	projectItems,
	checkpoint,
}: {
	sequence: TSequence;
	projectItems: ProjectItem[];
	checkpoint?: ApprovedCheckpoint;
}): ReviewIssue[] {
	const items = new Map(projectItems.map((item) => [item.id, item]));
	const used = new Map<string, TimelineClip[]>();
	for (const clip of allClips(sequence.tracks)) {
		if (!("mediaId" in clip)) continue;
		const list = used.get(clip.mediaId) ?? [];
		list.push(clip);
		used.set(clip.mediaId, list);
	}
	const approvedItems = new Map(
		checkpoint?.footage.map((item) => [item.projectItemId, item]),
	);
	const issues: ReviewIssue[] = [];
	for (const [id, clips] of used) {
		const item = items.get(id);
		const approved = approvedItems.get(id);
		const name = item?.name ?? approved?.name ?? clips[0].name;
		const path = item && "kind" in item.file ? item.file.path : undefined;
		const ranges = clips.map(
			({ id, startTime, trimStart, trimEnd, duration }) => ({
				id,
				startTime,
				trimStart,
				trimEnd,
				duration,
			}),
		);
		const span = clipSpan(clips[0]);
		if (!item || item.missing) {
			issues.push({
				id: `missing-footage:${id}`,
				kind: "missing-footage",
				title: "Missing recording",
				detail: `${name} is unavailable. Relink it to play its ${clips.length} clip(s).`,
				...span,
				evidence: hashText(stableStringify([path, ranges])),
			});
			continue;
		}
		if (
			approved &&
			(approved.missing ||
				approved.size !== item.file.size ||
				approved.lastModified !== item.file.lastModified ||
				approved.path !== path)
		) {
			issues.push({
				id: `changed-footage:${id}`,
				kind: "changed-footage",
				title: "Recording changed on disk",
				detail: `${name} has a different path, size, or modification time. Review the affected passage.`,
				...span,
				evidence: hashText(
					stableStringify([
						approved,
						path,
						item.file.size,
						item.file.lastModified,
						ranges,
					]),
				),
			});
		}
	}
	return issues;
}

function captionIssues({
	sequence,
	projectItems,
	captions,
	cues,
}: {
	sequence: TSequence;
	projectItems: ProjectItem[];
	captions?: ProjectCaptions;
	cues: Array<
		Pick<CaptionCue, "id" | "start" | "end" | "text" | "correctedBy">
	>;
}): ReviewIssue[] {
	const heard = new Map<string, TimelineClip>();
	for (const { clip } of audibleClips({
		tracks: sequence.tracks,
		projectItems,
	}))
		if (!projectItems.find(({ id }) => id === clip.mediaId)?.missing)
			if (!heard.has(clip.mediaId)) heard.set(clip.mediaId, clip);
	const issues: ReviewIssue[] = [];
	const sources = new Set(
		captions?.sources
			.filter(({ words }) => words.length > 0)
			.map(({ projectItemId }) => projectItemId),
	);
	if (heard.size > 0 && sources.size === 0)
		issues.push({
			id: `no-captions:${sequence.id}`,
			kind: "no-captions",
			title: "No captions",
			detail:
				"The SRT will be empty. Load the transcripts in Captions, or dismiss this to export without captions.",
			start: 0,
			end: 0,
			evidence: hashText(stableStringify([...heard])),
		});
	else
		for (const [projectItemId, clip] of heard) {
			if (sources.has(projectItemId)) continue;
			const name =
				projectItems.find(({ id }) => id === projectItemId)?.name ??
				projectItemId;
			issues.push({
				id: `uncaptioned:${projectItemId}`,
				kind: "uncaptioned-recording",
				title: "Recording without captions",
				detail: `${name} plays in the cut but has no caption words, so its narration is missing from the SRT.`,
				...clipSpan(clip),
				evidence: hashText(stableStringify(clip)),
			});
		}
	for (const cue of cues) {
		if (!cue.text.trim()) {
			// An empty cue correction deliberately hides the caption.
			if (cue.correctedBy !== "cue")
				issues.push({
					id: `caption-empty:${cue.id}`,
					kind: "caption-empty",
					title: "Empty caption",
					detail: "This cue has no text and will be left out of the SRT.",
					start: cue.start,
					end: cue.end,
					evidence: hashText(stableStringify(cue)),
				});
			continue;
		}
		const duration = Math.max(cue.end - cue.start, 0.001);
		const lines = wrapCueText(cue.text).split("\n").length;
		if (cue.text.length > MAX_CUE_CHARS || lines > 2)
			issues.push({
				id: `caption-overlong:${cue.id}`,
				kind: "caption-overlong",
				title: "Caption too long",
				detail: `${cue.text.length} characters on ${lines} lines; keep a cue to two lines of ${MAX_LINE_CHARS}.`,
				start: cue.start,
				end: cue.end,
				evidence: hashText(cue.text),
			});
		else if (cue.text.length / duration > MAX_CHARS_PER_SECOND)
			issues.push({
				id: `caption-fast:${cue.id}`,
				kind: "caption-fast",
				title: "Caption too fast to read",
				detail: `${Math.round(cue.text.length / duration)} characters a second for ${duration.toFixed(1)} s.`,
				start: cue.start,
				end: cue.end,
				evidence: hashText(`${cue.text}@${duration}`),
			});
	}
	return issues;
}

/** Removal markers whose kept take left the cut, or whose stored take plays in it. */
function markerIssues(sequence: TSequence): ReviewIssue[] {
	const clips = allClips(sequence.tracks);
	const issues: ReviewIssue[] = [];
	for (const marker of sequence.markers) {
		if (!marker.data) continue;
		const at = mediaTimeToSeconds({ time: marker.time });
		const { sectionName, bestTake, badTakes } = marker.data;
		const kept = takeRanges(bestTake).reduce(
			(total, range) => total + playedSeconds({ clips, ...range }).seconds,
			0,
		);
		if (kept === 0)
			issues.push({
				id: `marker-orphan:${marker.id}`,
				kind: "marker-conflict",
				title: "Kept take left the cut",
				detail: `No part of the kept take of “${sectionName}” plays any more. Restore or Swap a stored take, or dismiss this if the section was cut on purpose.`,
				start: at,
				end: at,
				evidence: hashText(stableStringify(marker.data)),
			});
		badTakes.forEach((take, index) => {
			const ranges = takeRanges(take);
			const played = ranges.map((range) => playedSeconds({ clips, ...range }));
			const seconds = played.reduce((total, { seconds }) => total + seconds, 0);
			const length = ranges.reduce(
				(total, { sourceIn, sourceOut }) => total + sourceOut - sourceIn,
				0,
			);
			if (seconds < Math.min(DUPLICATE_SECONDS, length / 2)) return;
			const start = played.find(({ at }) => at !== undefined)?.at ?? at;
			issues.push({
				id: `marker-duplicate:${marker.id}:${index}`,
				kind: "marker-conflict",
				title: "Stored take also plays",
				detail: `Stored take ${index + 1} of “${sectionName}” plays in the cut too, so its passage may be heard twice.`,
				start,
				end: start + seconds,
				evidence: hashText(
					stableStringify({ take, played: seconds.toFixed(1) }),
				),
			});
		});
	}
	return issues;
}

function flaggedIssues(sequence: TSequence): ReviewIssue[] {
	return sequence.markers.flatMap((marker) => {
		if (marker.data || !marker.note || !FLAG_NOTE.test(marker.note)) return [];
		const start = mediaTimeToSeconds({ time: marker.time });
		return [
			{
				id: `flagged:${marker.time}:${hashText(marker.note)}`,
				kind: "flagged" as const,
				title: "Flagged for review",
				detail: marker.note,
				start,
				end:
					start +
					(marker.duration ? mediaTimeToSeconds({ time: marker.duration }) : 0),
				evidence: hashText(stableStringify(marker)),
			},
		];
	});
}

/** Every review issue on the sequence, in sequence order. */
export function collectIssues({
	sequence,
	projectItems,
	horizontal,
	captions,
	cues,
	checkpoint,
	comparison,
}: {
	sequence: TSequence;
	projectItems: ProjectItem[];
	horizontal: boolean;
	captions?: ProjectCaptions;
	cues: Array<
		Pick<CaptionCue, "id" | "start" | "end" | "text" | "correctedBy">
	>;
	checkpoint?: ApprovedCheckpoint;
	comparison?: CheckpointComparison;
}): ReviewIssue[] {
	return [
		...(checkpoint && comparison
			? changedPassageIssues({ comparison, checkpoint })
			: []),
		...footageIssues({ sequence, projectItems, checkpoint }),
		...(horizontal
			? captionIssues({ sequence, projectItems, captions, cues })
			: []),
		...markerIssues(sequence),
		...flaggedIssues(sequence),
	]
		.map((issue) => ({ ...issue, id: `${sequence.id}:${issue.id}` }))
		.sort((a, b) => a.start - b.start);
}

/** Marks the issues a dismissal still covers: same issue, same evidence. */
export function applyDismissals({
	issues,
	dismissals,
}: {
	issues: ReviewIssue[];
	dismissals: Dismissal[];
}): ReviewIssue[] {
	const byId = new Map(dismissals.map((entry) => [entry.issueId, entry]));
	return issues.map((issue) => {
		const dismissal = byId.get(issue.id);
		return dismissal && dismissal.evidence === issue.evidence
			? {
					...issue,
					dismissed: {
						at: dismissal.at,
						by: dismissal.by,
						...(dismissal.reason && { reason: dismissal.reason }),
					},
				}
			: issue;
	});
}
