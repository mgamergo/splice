import type { CaptionStyle, CaptionsRequest } from "@splice/bridge/ops";
import { getClipTimeAtSourceTime, getSourceSpanAtClipTime } from "@/retime";
import {
	buildSubtitleTextClip,
	createMeasurementContext,
} from "@/subtitles/build-subtitle-text-clip";
import type { SubtitleCue, SubtitleStyleOverrides } from "@/subtitles/types";
import { buildEmptyTrack } from "@/timeline/placement";
import { calculateTotalDuration } from "@/timeline";
import { isClipMuted } from "@/timeline/audio-state";
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
/** A silence this long between words starts a new caption. */
const CAPTION_BREAK_GAP_SECONDS = 0.5;
/** whisper.cpp sometimes gives a word no duration; it still gets shown. */
const MIN_WORD_SECONDS = 0.08;
/**
 * The shortest caption shown: three frames at 30 fps. Captions stacked on one
 * time merge rather than flash by unseen.
 */
const MIN_CAPTION_SECONDS = 0.1;
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
		// Words nobody hears aren't captioned.
		if ("muted" in track && track.muted) continue;
		for (const clip of track.clips) {
			if (
				(clip.type !== "video" && clip.type !== "audio") ||
				!("mediaId" in clip) ||
				isClipMuted({ clip }) ||
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
				const wordEnd =
					word.end > word.start ? word.end : word.start + MIN_WORD_SECONDS;
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
	let index = 0;
	while (index < groups.length) {
		// whisper.cpp can stack several words on one time. Captions starting
		// together share the time until the next caption, so nothing drifts.
		const start = groups[index][0].start;
		let runEnd = index + 1;
		while (runEnd < groups.length && groups[runEnd][0].start <= start) runEnd++;
		const run = groups.slice(index, runEnd);
		const nextStart = groups[runEnd]?.[0].start ?? Number.POSITIVE_INFINITY;
		const end = Math.min(
			nextStart,
			Math.max(...run.map((group) => group.at(-1)!.end)) + CAPTION_HOLD_SECONDS,
		);
		// Too many to show each for MIN_CAPTION_SECONDS: merge neighbours.
		const count = Math.max(
			1,
			Math.min(
				run.length,
				Math.floor((end - start) / MIN_CAPTION_SECONDS + 1e-9),
			),
		);
		const share = (end - start) / count;
		for (let offset = 0; offset < count; offset++) {
			const text = run
				.slice(
					Math.floor((offset * run.length) / count),
					Math.floor(((offset + 1) * run.length) / count),
				)
				.flat()
				.map(({ text }) => text)
				.join(" ");
			cues.push({
				text: style.uppercase ? text.toUpperCase() : text,
				startTime: start + offset * share,
				duration: share,
				style: overrides,
			});
		}
		index = runEnd;
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
		overlay: tracks.overlay.filter((track) => !isCaptionTrack(track)),
	};
}

function isCaptionTrack(
	track: SequenceTracks["overlay"][number],
): track is TextTrack {
	return track.type === "text" && track.name === CAPTION_TRACK_NAME;
}

/**
 * Caption clips for the words heard in [from, until) on the timeline, ending
 * by `until` and where the content ends. Words outside the range don't join
 * a caption inside it, so neighbouring kept captions never repeat a word.
 */
function captionClips({
	content,
	captions,
	canvasSize,
	from = 0,
	until = Number.POSITIVE_INFINITY,
}: {
	content: SequenceTracks;
	captions: CaptionsRequest;
	canvasSize: { width: number; height: number };
	from?: number;
	until?: number;
}): TextTrack["clips"] {
	const words = mapWordsToTimeline({
		tracks: content,
		sources: captions.sources,
	}).filter(({ start }) => start >= from && start < until);
	const end = Math.min(
		until,
		mediaTimeToSeconds({ time: calculateTotalDuration({ tracks: content }) }),
	);
	const ctx = createMeasurementContext();
	return buildCaptionCues({ words, style: captions.style })
		.filter((cue) => cue.startTime < end)
		.map((cue, index) => ({
			...buildSubtitleTextClip({
				index,
				caption: {
					...cue,
					duration: Math.min(cue.duration, end - cue.startTime),
				},
				canvasSize,
				ctx,
			}),
			id: generateUUID(),
		}));
}

/** Recordings on the timeline whose words weren't given, so got no captions. */
function uncaptionedItemIds({
	content,
	captions,
}: {
	content: SequenceTracks;
	captions: CaptionsRequest;
}): string[] {
	const given = new Set(captions.sources.map(({ projectItemId }) => projectItemId));
	return [...sourceClips({ tracks: content }).keys()].filter(
		(id) => !given.has(id),
	);
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
}): {
	tracks: SequenceTracks;
	captionCount: number;
	uncaptionedItemIds: string[];
} {
	const content = withoutCaptionTrack({ tracks });
	const clips = captionClips({ content, captions, canvasSize });
	if (!clips.length)
		throw new CaptionError(
			"No transcript words fall inside the sequence's clips. Transcribe the recordings on this sequence first.",
		);
	const track: TextTrack = {
		...buildEmptyTrack({
			id: generateUUID(),
			type: "text",
			name: CAPTION_TRACK_NAME,
		}),
		clips,
	};
	return {
		tracks: { ...content, overlay: [track, ...content.overlay] },
		captionCount: clips.length,
		uncaptionedItemIds: uncaptionedItemIds({ content, captions }),
	};
}

/**
 * Captions are derived from the sequence's stored transcript words. An edit
 * that moves takes rebuilds just the captions in the window it changed and
 * shifts the rest, so hand corrections elsewhere survive.
 */
export function rebuildCaptions({
	sequence,
	tracks,
	canvasSize,
	window,
}: {
	sequence: TSequence;
	tracks: SequenceTracks;
	canvasSize: { width: number; height: number };
	/** The edited range in the old timeline, and how much later content moved. */
	window: { start: number; end: number; delta: number };
}): SequenceTracks {
	const { captions } = sequence;
	if (!captions) return tracks;
	const content = withoutCaptionTrack({ tracks });
	const previous = sequence.tracks.overlay.find(isCaptionTrack);
	if (!previous) {
		const clips = captionClips({ content, captions, canvasSize });
		if (!clips.length) return content;
		const track: TextTrack = {
			...buildEmptyTrack({
				id: generateUUID(),
				type: "text",
				name: CAPTION_TRACK_NAME,
			}),
			clips,
		};
		return { ...content, overlay: [track, ...content.overlay] };
	}

	const before = previous.clips.filter(
		(clip) => clip.startTime + clip.duration <= window.start,
	);
	const after = previous.clips
		.filter((clip) => clip.startTime >= window.end)
		.map((clip) => ({
			...clip,
			startTime: roundMediaTime({ time: clip.startTime + window.delta }),
		}));
	// Fresh captions fill the gap between the kept ones, including any that
	// straddled the window's edges, from only the words heard in the gap.
	const from = mediaTimeToSeconds({
		time: roundMediaTime({
			time: Math.max(0, ...before.map((clip) => clip.startTime + clip.duration)),
		}),
	});
	const until = Math.min(
		Number.POSITIVE_INFINITY,
		...after.map((clip) => mediaTimeToSeconds({ time: clip.startTime })),
	);
	const between = captionClips({ content, captions, canvasSize, from, until });
	return {
		...content,
		overlay: [
			{ ...previous, clips: [...before, ...between, ...after] },
			...content.overlay,
		],
	};
}
