import type { CaptionStyle, CaptionsRequest } from "@splice/bridge/ops";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import {
	buildSubtitleTextClip,
	createMeasurementContext,
} from "@/subtitles/build-subtitle-text-clip";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import { buildEmptyTrack } from "@/timeline/placement";
import { calculateTotalDuration } from "@/timeline";
import type {
	AudioClip,
	SequenceTracks,
	TextTrack,
	TSequence,
	VideoClip,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	roundMediaTime,
} from "@/wasm";

/** The text track that holds burned-in captions. Adding captions replaces it. */
export const CAPTION_TRACK_NAME = "Captions";

const DEFAULT_WORDS_PER_CAPTION = 3;
const DEFAULT_FONT_SIZE = 8;
/** A caption stays up this long after its last word unless the next one starts. */
const CAPTION_HOLD_SECONDS = 0.3;
/** How long a caption stays up when the next one starts at the same time. */
const STACKED_CAPTION_SECONDS = 0.2;
/** A silence this long between words starts a new caption. */
const CAPTION_BREAK_GAP_SECONDS = 0.5;
/** whisper.cpp sometimes gives a word no duration; it still gets shown. */
const MIN_WORD_SECONDS = 0.08;
const SENTENCE_END = /[.!?,;:…]["')\]]*$/;

export class CaptionError extends Error {}

export interface TimelineWord {
	/** Timeline seconds. */
	start: number;
	end: number;
	text: string;
}

type SourceClip = VideoClip | AudioClip;

/**
 * The clips whose sound carries each recording's words: video with its own
 * audio (even if hidden) and audio clips. A video whose audio was extracted
 * is skipped, because the extracted clip says the words where it now sits.
 */
function sourceClips({ tracks }: { tracks: SequenceTracks }) {
	const byItem = new Map<string, SourceClip[]>();
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		for (const clip of track.clips) {
			if (
				(clip.type !== "video" && clip.type !== "audio") ||
				!("mediaId" in clip) ||
				(clip.type === "video" && clip.isSourceAudioEnabled === false)
			)
				continue;
			byItem.set(clip.mediaId, [...(byItem.get(clip.mediaId) ?? []), clip]);
		}
	}
	return byItem;
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
	// The same word heard from two clips at one time (e.g. a copy on another
	// track) is captioned once.
	const seen = new Set<string>();
	for (const { projectItemId, words: sourceWords } of sources) {
		for (const clip of clipsByItem.get(projectItemId) ?? []) {
			const trimStart = mediaTimeToSeconds({ time: clip.trimStart });
			const clipStart = mediaTimeToSeconds({ time: clip.startTime });
			const clipEnd = clipStart + mediaTimeToSeconds({ time: clip.duration });
			const sourceOut =
				trimStart +
				mediaTimeToSeconds({
					time: roundMediaTime({
						time: getSourceSpanAtClipTime({
							clipTime: clip.duration,
							retime: clip.retime,
						}),
					}),
				});
			const toTimeline = (sourceSeconds: number) =>
				clipStart +
				mediaTimeToSeconds({
					time: roundMediaTime({
						time: getClipTimeAtSourceTime({
							sourceTime: mediaTimeFromSeconds({
								seconds: sourceSeconds - trimStart,
							}),
							retime: clip.retime,
						}),
					}),
				});
			for (const [index, word] of sourceWords.entries()) {
				const text = word.text.trim();
				const wordEnd = Math.max(word.end, word.start + MIN_WORD_SECONDS);
				const middle = (word.start + wordEnd) / 2;
				if (!text || middle < trimStart || middle >= sourceOut) continue;
				const start = Math.max(
					clipStart,
					toTimeline(Math.max(word.start, trimStart)),
				);
				const end = Math.min(clipEnd, toTimeline(Math.min(wordEnd, sourceOut)));
				const key = `${projectItemId}:${index}:${Math.round(start * 1000)}`;
				if (end > start && !seen.has(key)) {
					seen.add(key);
					words.push({ start, end, text });
				}
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
	const cues: SubtitleCue[] = [];
	let previousEnd = 0;
	for (const [index, group] of groups.entries()) {
		// Words whisper.cpp stacks on one time still get a readable moment each.
		const startTime = Math.max(group[0].start, previousEnd);
		const nextStart = groups[index + 1]?.[0].start ?? Number.POSITIVE_INFINITY;
		const natural = Math.min(
			nextStart,
			group.at(-1)!.end + CAPTION_HOLD_SECONDS,
		);
		// Only stacked captions are pushed back, so normal speech never drifts.
		const end =
			natural > startTime ? natural : startTime + STACKED_CAPTION_SECONDS;
		const text = group.map(({ text }) => text).join(" ");
		cues.push({
			text: style.uppercase ? text.toUpperCase() : text,
			startTime,
			duration: end - startTime,
			style: overrides,
		});
		previousEnd = end;
	}
	return cues;
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

export function withoutCaptionTrack({
	tracks,
}: {
	tracks: SequenceTracks;
}): SequenceTracks {
	return {
		...tracks,
		overlay: tracks.overlay.filter(({ name }) => name !== CAPTION_TRACK_NAME),
	};
}

/**
 * Returns the tracks with the Captions track rebuilt from the words, ending
 * where the sequence's other content ends.
 */
export function withCaptionTrack({
	tracks,
	captions,
	canvasSize,
}: {
	tracks: SequenceTracks;
	captions: CaptionsRequest;
	canvasSize: { width: number; height: number };
}): { tracks: SequenceTracks; captionCount: number } {
	const content = withoutCaptionTrack({ tracks });
	const words = mapWordsToTimeline({
		tracks: content,
		sources: captions.sources,
	});
	if (!words.length)
		throw new CaptionError(
			"No transcript words fall inside the sequence's clips. Transcribe the recordings on this sequence first.",
		);
	const contentEnd = mediaTimeToSeconds({
		time: calculateTotalDuration({ tracks: content }),
	});
	const cues = buildCaptionCues({ words, style: captions.style }).flatMap(
		(cue) =>
			cue.startTime < contentEnd
				? [
						{
							...cue,
							duration: Math.min(cue.duration, contentEnd - cue.startTime),
						},
					]
				: [],
	);
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
		tracks: { ...content, overlay: [track, ...content.overlay] },
		captionCount: cues.length,
	};
}

/**
 * Captions are derived from the sequence's stored transcript words, so edits
 * that move takes rebuild them instead of rippling stale words around.
 */
export function rebuildCaptions({
	sequence,
	tracks,
	canvasSize,
}: {
	sequence: TSequence;
	tracks: SequenceTracks;
	canvasSize: { width: number; height: number };
}): SequenceTracks {
	if (!sequence.captions) return tracks;
	try {
		return withCaptionTrack({ tracks, captions: sequence.captions, canvasSize })
			.tracks;
	} catch (error) {
		if (!(error instanceof CaptionError)) throw error;
		return withoutCaptionTrack({ tracks });
	}
}
