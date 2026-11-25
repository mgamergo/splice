import type { z } from "zod";
import type { shortHookRequestSchema } from "@splice/bridge/ops";
import { CAPTION_TRACK_NAME } from "@/agent/short-captions";
import { mapWordsToTimeline } from "@/agent/captions";
import { locateSourceTime } from "@/agent/graphics";
import { buildSubtitleTextClip } from "@/subtitles/build-subtitle-text-clip";
import { buildEmptyTrack } from "@/timeline/placement";
import type { TSequence, TextTrack } from "@/timeline/types";
import type { TCanvasSize } from "@/project/types";
import { mediaTimeToSeconds } from "@/wasm";
import { generateUUID } from "@/utils/id";

const HOOK_TRACK_NAME = "Opening hook";
const normalize = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();

export function isHookTrack(
	track: TSequence["tracks"]["overlay"][number],
): track is TextTrack & { name: typeof HOOK_TRACK_NAME } {
	return track.type === "text" && track.name === HOOK_TRACK_NAME;
}

export function planShortHook({
	sequence,
	hook,
	canvas,
}: {
	sequence: TSequence;
	hook: z.infer<typeof shortHookRequestSchema>["hook"];
	canvas: TCanvasSize;
}) {
	const previous = sequence.tracks.overlay.find(isHookTrack);
	const overlay = sequence.tracks.overlay.filter(
		(track) => !isHookTrack(track),
	);
	if (!hook)
		return {
			status: "removed" as const,
			tracks: { ...sequence.tracks, overlay },
		};

	const { evidence, demonstrationStart, text } = hook;
	const anchor = locateSourceTime({
		tracks: sequence.tracks,
		projectItemId: evidence.projectItemId,
		sourceTime: evidence.time,
		near: 0,
	});
	if (
		!anchor ||
		anchor.time >= demonstrationStart ||
		anchor.clip.startTime !== 0 ||
		mediaTimeToSeconds({ time: anchor.clip.duration }) < demonstrationStart
	)
		return {
			error:
				"The hook evidence must be in the visible opening before the demonstration.",
		};

	const opening = mapWordsToTimeline({
		tracks: sequence.tracks,
		sources: sequence.captions?.sources ?? [],
	}).filter(({ start }) => start < demonstrationStart);
	const narration = normalize(opening.map((word) => word.text).join(" "));
	const spokenEvidence = normalize(
		opening
			.filter(
				({ start, end }) => start < anchor.time + 1 && end > anchor.time - 1,
			)
			.map((word) => word.text)
			.join(" "),
	);
	const detail = normalize(evidence.detail);
	if (
		evidence.kind === "narration" &&
		(!detail || !(" " + spokenEvidence + " ").includes(" " + detail + " "))
	)
		return {
			error:
				"The narration evidence must quote opening caption words near the supplied time. Use footage evidence for an observed detail.",
		};

	const normalized = normalize(text);
	if (!normalized) return { error: "The hook needs words." };
	if ((" " + narration + " ").includes(" " + normalized + " "))
		return { status: "skipped_redundant" as const };

	const clip = buildSubtitleTextClip({
		index: 0,
		caption: {
			text,
			startTime: 0,
			duration: demonstrationStart,
			style: {
				fontSize: 6,
				background: { enabled: true, color: "#0f172acc" },
				placement: { verticalAlign: "top", marginVerticalRatio: 0.1 },
			},
		},
		canvasSize: canvas,
	});
	const captionIndex = overlay.findIndex(
		(track) => track.type === "text" && track.name === CAPTION_TRACK_NAME,
	);
	const at = captionIndex + 1;
	const track =
		previous ??
		buildEmptyTrack({
			id: generateUUID(),
			type: "text",
			name: HOOK_TRACK_NAME,
		});
	return {
		status: "placed" as const,
		tracks: {
			...sequence.tracks,
			overlay: [
				...overlay.slice(0, at),
				{
					...track,
					clips: [
						{
							...clip,
							id: previous?.clips[0]?.id ?? generateUUID(),
							name: HOOK_TRACK_NAME,
						},
					],
				},
				...overlay.slice(at),
			],
		},
	};
}
