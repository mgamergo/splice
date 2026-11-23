import type { CaptionStyle, CaptionsRequest } from "@splice/bridge/ops";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import {
	buildSubtitleTextClip,
	createMeasurementContext,
} from "@/subtitles/build-subtitle-text-clip";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import { buildEmptyTrack } from "@/timeline/placement";
import type {
	AudioClip,
	SequenceTracks,
	TextTrack,
	VideoClip,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

/** The text track that holds burned-in captions. Adding captions replaces it. */
export const CAPTION_TRACK_NAME = "Captions";

const DEFAULT_WORDS_PER_CAPTION = 3;
const DEFAULT_FONT_SIZE = 8;
/** A caption stays up this long after its last word unless the next one starts. */
const CAPTION_HOLD_SECONDS = 0.3;
/** A silence this long between words starts a new caption. */
const CAPTION_BREAK_GAP_SECONDS = 0.5;
const SENTENCE_END = /[.!?,;:…]["')\]]*$/;

export class CaptionError extends Error {}

export interface TimelineWord {
	/** Timeline seconds. */
	start: number;
	end: number;
	text: string;
}

type SourceClip = VideoClip | AudioClip;

function sourceClips({ tracks }: { tracks: SequenceTracks }) {
	const byItem = new Map<
		string,
		{ video: SourceClip[]; audio: SourceClip[] }
	>();
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const clip of track.clips) {
			if (
				(clip.type !== "video" && clip.type !== "audio") ||
				!("mediaId" in clip)
			)
				continue;
			if (clip.type === "video" && clip.hidden) continue;
			const entry = byItem.get(clip.mediaId) ?? { video: [], audio: [] };
			entry[clip.type].push(clip);
			byItem.set(clip.mediaId, entry);
		}
	}
	// A video clip and the audio extracted from it show the same words once.
	return new Map(
		[...byItem].map(([id, { video, audio }]) => [
			id,
			video.length ? video : audio,
		]),
	);
}

/**
 * Places each transcript word on the timeline through the clips that show its
 * source time. A word appears once per clip that keeps its midpoint, so words
 * in cut ranges drop out and repeated source ranges caption every repeat.
 */
export function mapWordsToTimeline({
	tracks,
	sources,
}: {
	tracks: SequenceTracks;
	sources: CaptionsRequest["sources"];
}): TimelineWord[] {
	const clipsByItem = sourceClips({ tracks });
	const words: TimelineWord[] = [];
	for (const { projectItemId, words: sourceWords } of sources) {
		for (const clip of clipsByItem.get(projectItemId) ?? []) {
			const trimStart = mediaTimeToSeconds({ time: clip.trimStart });
			const clipStart = mediaTimeToSeconds({ time: clip.startTime });
			const clipEnd = clipStart + mediaTimeToSeconds({ time: clip.duration });
			const sourceOut =
				trimStart +
				mediaTimeToSeconds({
					time: getSourceSpanAtClipTime({
						clipTime: clip.duration,
						retime: clip.retime,
					}),
				});
			const toTimeline = (sourceSeconds: number) =>
				clipStart +
				mediaTimeToSeconds({
					time: getClipTimeAtSourceTime({
						sourceTime: mediaTimeFromSeconds({
							seconds: sourceSeconds - trimStart,
						}),
						retime: clip.retime,
					}),
				});
			for (const word of sourceWords) {
				const text = word.text.trim();
				const middle = (word.start + word.end) / 2;
				if (!text || middle < trimStart || middle >= sourceOut) continue;
				const start = Math.max(
					clipStart,
					toTimeline(Math.max(word.start, trimStart)),
				);
				const end = Math.min(
					clipEnd,
					toTimeline(Math.min(word.end, sourceOut)),
				);
				if (end > start) words.push({ start, end, text });
			}
		}
	}
	return words.sort((a, b) => a.start - b.start);
}

/** Groups words into short captions that break at punctuation and pauses. */
export function buildCaptionCues({
	words,
	style = {},
}: {
	words: TimelineWord[];
	style?: CaptionStyle;
}): SubtitleCue[] {
	const limit = style.wordsPerCaption ?? DEFAULT_WORDS_PER_CAPTION;
	const groups: TimelineWord[][] = [];
	let current: TimelineWord[] = [];
	for (const word of words) {
		const previous = current.at(-1);
		if (
			previous &&
			(current.length >= limit ||
				SENTENCE_END.test(previous.text) ||
				word.start - previous.end > CAPTION_BREAK_GAP_SECONDS)
		) {
			groups.push(current);
			current = [];
		}
		current.push(word);
	}
	if (current.length) groups.push(current);

	const overrides = styleOverrides({ style });
	return groups.flatMap((group, index) => {
		const startTime = group[0].start;
		const nextStart = groups[index + 1]?.[0].start ?? Number.POSITIVE_INFINITY;
		const end = Math.min(nextStart, group.at(-1)!.end + CAPTION_HOLD_SECONDS);
		if (end <= startTime) return [];
		const text = group.map(({ text }) => text).join(" ");
		return [
			{
				text: style.uppercase ? text.toUpperCase() : text,
				startTime,
				duration: end - startTime,
				style: overrides,
			},
		];
	});
}

function styleOverrides({
	style,
}: {
	style: CaptionStyle;
}): SubtitleStyleOverrides {
	const position = style.position ?? "bottom";
	return {
		fontSize: style.fontSize ?? DEFAULT_FONT_SIZE,
		fontFamily: style.fontFamily,
		fontWeight: "bold",
		color: style.color ?? "#ffffff",
		background:
			style.background === "none"
				? { enabled: false, color: "#000000" }
				: { enabled: true, color: style.background ?? "#000000" },
		placement: {
			verticalAlign: position,
			// Clear of the title and buttons that Shorts players draw at the bottom.
			marginVerticalRatio: position === "middle" ? undefined : 0.22,
		},
	};
}

/** Returns the tracks with the Captions track replaced by one built from the words. */
export function withCaptionTrack({
	tracks,
	captions,
	canvasSize,
}: {
	tracks: SequenceTracks;
	captions: CaptionsRequest;
	canvasSize: { width: number; height: number };
}): { tracks: SequenceTracks; captionCount: number } {
	const words = mapWordsToTimeline({ tracks, sources: captions.sources });
	if (!words.length)
		throw new CaptionError(
			"No transcript words fall inside the sequence's clips. Transcribe the recordings on this sequence first.",
		);
	const cues = buildCaptionCues({ words, style: captions.style });
	const ctx = createMeasurementContext();
	const track: TextTrack = {
		...buildEmptyTrack({
			id: generateUUID(),
			type: "text",
			name: CAPTION_TRACK_NAME,
		}),
		clips: cues.map((caption, index) => ({
			...buildSubtitleTextClip({ index, caption, canvasSize, ctx }),
			id: generateUUID(),
		})),
	};
	return {
		tracks: {
			...tracks,
			overlay: [
				track,
				...tracks.overlay.filter(({ name }) => name !== CAPTION_TRACK_NAME),
			],
		},
		captionCount: cues.length,
	};
}
