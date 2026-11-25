import type { ItemRange } from "@splice/bridge/ops";
import type {
	CorrectionEdit,
	TighteningEdge,
	TighteningKind,
} from "@splice/bridge/profile";
import { isDiskMedia } from "@/media/media-data";
import type { ProjectItem } from "@/media/types";
import { getSourceSpanAtClipTime } from "@/retime";
import { hasMediaId, isRetimableClip, type TimelineClip } from "@/timeline";
import { normalizeRanges, type TimeRange } from "@/timeline/ripple-delete";
import { type MediaTime, mediaTimeToSeconds, roundMediaTime } from "@/wasm";

export function recordingRanges({
	ranges,
	items,
}: {
	ranges: ItemRange[];
	items: ProjectItem[];
}) {
	return ranges.map(({ projectItemId, sourceIn, sourceOut }) => {
		const item = items.find(({ id }) => id === projectItemId);
		return {
			projectItemId,
			recording:
				item && isDiskMedia(item.file)
					? item.file.path
					: (item?.name ?? projectItemId),
			sourceIn,
			sourceOut,
		};
	});
}

const seconds = (time: number) =>
	mediaTimeToSeconds({ time: roundMediaTime({ time }) });

export function retrimCorrections({
	before,
	after,
	patch,
	items,
}: {
	before: TimelineClip;
	after: TimelineClip;
	patch: Partial<TimelineClip>;
	items: ProjectItem[];
}): CorrectionEdit[] {
	if (
		!isRetimableClip(before) ||
		!isRetimableClip(after) ||
		!("mediaId" in before) ||
		!("mediaId" in after) ||
		before.mediaId !== after.mediaId ||
		(!(before.tighteningIn && patch.trimStart !== undefined) &&
			!(before.tighteningOut && patch.trimEnd !== undefined)) ||
		before.retime?.rate !== after.retime?.rate
	)
		return [];

	const sourceRange = (clip: typeof before) => ({
		projectItemId: before.mediaId,
		sourceIn: seconds(clip.trimStart),
		sourceOut: seconds(
			clip.trimStart +
				getSourceSpanAtClipTime({
					clipTime: clip.duration,
					retime: clip.retime,
				}),
		),
	});
	const previous = sourceRange(before);
	const next = sourceRange(after);
	const changed: Array<{ edge: "in" | "out"; cut: TighteningEdge }> = [];
	if (
		before.tighteningIn &&
		patch.trimStart !== undefined &&
		previous.sourceIn !== next.sourceIn
	)
		changed.push({ edge: "in", cut: before.tighteningIn });
	if (
		before.tighteningOut &&
		patch.trimEnd !== undefined &&
		previous.sourceOut !== next.sourceOut
	)
		changed.push({ edge: "out", cut: before.tighteningOut });
	return changed.map(({ edge, cut }) => ({
		kind: "retrim",
		before: recordingRanges({ ranges: [previous], items }),
		after: recordingRanges({ ranges: [next], items }),
		decision: { edge, ...cut },
	}));
}

type CutDecision = TimeRange & { kind: TighteningKind; pauseSeconds?: number };

/** Tags the surviving clip edges before ripple moves them away from the cut. */
export function tagTighteningEdges({
	cuts,
	takeCuts,
	falseStarts,
	fillerWords,
	pauses,
}: {
	cuts: TimeRange[];
	takeCuts: TimeRange[];
	falseStarts: TimeRange[];
	fillerWords: TimeRange[];
	pauses: Array<{ windows: TimeRange[]; pauseSeconds: number }>;
}) {
	const silent: CutDecision[] = pauses.flatMap(({ windows, pauseSeconds }) =>
		windows.map((window) => ({ ...window, kind: "pause", pauseSeconds })),
	);
	// A spoken cut can start or end in breath padding after it snaps to silence.
	const spoken = (windows: TimeRange[], kind: TighteningKind): CutDecision[] =>
		windows.map(({ start, end }) => ({
			start:
				silent.find((pause) => pause.start <= start && start < pause.end)
					?.start ?? start,
			end:
				silent.find((pause) => pause.start < end && end <= pause.end)?.end ??
				end,
			kind,
		}));
	const decisions = [
		...spoken(falseStarts, "false_start"),
		...spoken(fillerWords, "filler_word"),
		...silent,
	];
	const removed = normalizeRanges({ ranges: cuts });
	const atEdge = (edge: "start" | "end") => {
		const byTime = new Map<MediaTime, CutDecision>();
		for (const cut of removed) {
			const time = cut[edge];
			const touches = ({ start, end }: TimeRange) =>
				edge === "start"
					? start <= time && time < end
					: start < time && time <= end;
			if (takeCuts.some(touches)) continue;
			const decision = decisions.find(touches);
			if (decision) byTime.set(time, { ...decision, ...cut });
		}
		return byTime;
	};
	const afterCut = atEdge("end");
	const beforeCut = atEdge("start");

	return <TClip extends TimelineClip>(piece: TClip, original: TClip): TClip => {
		if (!isRetimableClip(original) || !hasMediaId(original)) return piece;
		const originalEnd = roundMediaTime({
			time: original.startTime + original.duration,
		});
		const pieceEnd = roundMediaTime({ time: piece.startTime + piece.duration });
		const toSource = (time: number) =>
			seconds(
				original.trimStart +
					getSourceSpanAtClipTime({
						clipTime: roundMediaTime({ time: time - original.startTime }),
						retime: original.retime,
					}),
			);
		const describe = (
			decision: CutDecision | undefined,
		): TighteningEdge | undefined => {
			if (!decision) return undefined;
			const sourceIn = toSource(Math.max(decision.start, original.startTime));
			const sourceOut = toSource(Math.min(decision.end, originalEnd));
			if (sourceOut <= sourceIn) return undefined;
			return {
				kind: decision.kind,
				sourceIn,
				sourceOut,
				removedSeconds: sourceOut - sourceIn,
				...(decision.pauseSeconds !== undefined && {
					pauseSeconds: decision.pauseSeconds,
				}),
			};
		};
		const tighteningIn =
			piece.startTime !== original.startTime
				? describe(afterCut.get(piece.startTime))
				: undefined;
		const tighteningOut =
			pieceEnd !== originalEnd ? describe(beforeCut.get(pieceEnd)) : undefined;
		return {
			...piece,
			...(tighteningIn && { tighteningIn }),
			...(tighteningOut && { tighteningOut }),
		};
	};
}
