import type { z } from "zod";
import type { shortHookRequestSchema } from "@splice/bridge/ops";
import { CAPTION_TRACK_NAME } from "@/agent/short-captions";
import { mapWordsToTimeline } from "@/agent/captions";
import { locateSourceTime, screenSignature } from "@/agent/graphics";
import { buildSubtitleTextClip } from "@/subtitles/build-subtitle-text-clip";
import { buildEmptyTrack } from "@/timeline/placement";
import type {
	SequenceTracks,
	ShortHookAnchors,
	TSequence,
	TextTrack,
} from "@/timeline/types";
import type { TCanvasSize } from "@/project/types";
import { getSourceTimeAtClipTime } from "@/retime";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";
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

function demonstrationAnchor({
	tracks,
	time,
}: {
	tracks: SequenceTracks;
	time: number;
}): ShortHookAnchors["demonstration"] | undefined {
	const at = mediaTimeFromSeconds({ seconds: time });
	for (const track of [...tracks.overlay, tracks.main]) {
		if (track.type !== "video" || track.hidden) continue;
		const clip = track.clips.find(
			(clip) =>
				!clip.hidden &&
				clip.startTime <= at &&
				at < clip.startTime + clip.duration,
		);
		if (clip?.type !== "video") continue;
		return {
			projectItemId: clip.mediaId,
			sourceTime: mediaTimeToSeconds({
				time: roundMediaTime({
					time:
						clip.trimStart +
						getSourceTimeAtClipTime({
							clipTime: at - clip.startTime,
							retime: clip.retime,
						}),
				}),
			}),
			preferredClipId: clip.id,
		};
	}
}

export function syncShortHooks({
	tracks,
}: {
	tracks: SequenceTracks;
}): SequenceTracks {
	if (!tracks.overlay.some(isHookTrack)) return tracks;
	const picture = screenSignature(tracks);
	const overlay = tracks.overlay.map((track) => {
		if (!isHookTrack(track)) return track;
		const clips = track.clips.map((clip) => {
			const anchors = clip.shortHook;
			if (!anchors || anchors.picture === picture) return clip;
			const evidence = locateSourceTime({
				tracks,
				...anchors.evidence,
				near: 0,
			});
			const demonstration = locateSourceTime({
				tracks,
				...anchors.demonstration,
				near: mediaTimeToSeconds({ time: clip.duration }),
			});
			if (
				!evidence ||
				!demonstration ||
				evidence.clip.startTime !== 0 ||
				evidence.time >= demonstration.time
			)
				return {
					...clip,
					shortHook: { ...anchors, picture, unavailable: true as const },
				};
			return {
				...clip,
				startTime: mediaTimeFromSeconds({ seconds: 0 }),
				duration: mediaTimeFromSeconds({ seconds: demonstration.time }),
				shortHook: { ...anchors, picture, unavailable: undefined },
			};
		});
		return clips.some((clip, index) => clip !== track.clips[index])
			? { ...track, clips }
			: track;
	});
	return overlay.some((track, index) => track !== tracks.overlay[index])
		? { ...tracks, overlay }
		: tracks;
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

	const demonstration = demonstrationAnchor({
		tracks: sequence.tracks,
		time: demonstrationStart,
	});
	if (!demonstration)
		return { error: "Set the demonstration start on visible video footage." };

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
							shortHook: {
								evidence: {
									projectItemId: evidence.projectItemId,
									sourceTime: evidence.time,
									preferredClipId: anchor.clip.id,
								},
								demonstration,
								picture: screenSignature(sequence.tracks),
							},
						},
					],
				},
				...overlay.slice(at),
			],
		},
	};
}
