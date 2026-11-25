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
 * The shortest caption shown: three frames at 30 fps. Shorter captions merge
 * with the next one rather than flash by unseen.
 */
const MIN_CAPTION_SECONDS = 0.1;
/** Word starts closer than this are one time, allowing for tick rounding. */
const SAME_TIME_SECONDS = 0.002;
const SENTENCE_END =/[.!?,;:…]["')\]]*$/;

export class CaptionError extends Error {}

export interface TimelineWord {
	/** Timeline seconds. */
	start: number;
	end: number;
	text: string;
	/** The transcript word it shows: its recording and position there. */
	ref: { projectItemId: string; index: number };
	/** The clip it is heard through. */
	clipId: string;
}

type SourceClip = VideoClip | AudioClip;
type SourceWords = CaptionsRequest["sources"][number]["words"];
type ClipWord = Pick<TimelineWord, "start" | "end" | "text"> & { index: number };

interface CachedClipWords {
	sourceWords: SourceWords;
	trimStart: SourceClip["trimStart"];
	duration: SourceClip["duration"];
	rate: number | undefined;
	words: ClipWord[];
}

/** One mapping per clip, in clip-relative time so it survives a move. */
export type ClipWordCache = Map<string, CachedClipWords>;

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
			const clips = byItem.get(clip.mediaId);
			if (clips) clips.push(clip);
			else byItem.set(clip.mediaId, [clip]);
		}
	}
	return byItem;
}

/** Keeps the words whose midpoints fall in the clip's source range. */
function wordsInClip({
	clip,
	sourceWords,
}: {
	clip: SourceClip;
	sourceWords: SourceWords;
}): ClipWord[] {
	const trimStart = mediaTimeToSeconds({ time: clip.trimStart });
	const duration = mediaTimeToSeconds({ time: clip.duration });
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
	const toClipTime = (sourceSeconds: number) =>
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
	const words: ClipWord[] = [];
	for (let index = 0; index < sourceWords.length; index++) {
		const word = sourceWords[index];
		const wordEnd =
			word.end > word.start ? word.end : word.start + MIN_WORD_SECONDS;
		const middle = (word.start + wordEnd) / 2;
		if (middle < trimStart || middle >= sourceOut) continue;
		const text = word.text.trim();
		if (!text) continue;
		const start = Math.max(0, toClipTime(Math.max(word.start, trimStart)));
		const end = Math.min(duration, toClipTime(Math.min(wordEnd, sourceOut)));
		if (end > start) words.push({ start, end, text, index });
	}
	return words;
}

/**
 * Places each transcript word on the timeline through the clips that show its
 * source time. Repeated source ranges caption every repeat.
 */
export function mapWordsToTimeline({
	tracks,
	sources,
	wordCache,
}: {
	tracks: SequenceTracks;
	sources: CaptionsRequest["sources"];
	wordCache?: ClipWordCache;
}): TimelineWord[] {
	const clipsByItem = sourceClips({ tracks });
	const words: TimelineWord[] = [];
	const usedClips = new Set<string>();
	// The same word heard from two clips at one time (e.g. a copy on another
	// track) is captioned once.
	const seen = new Set<string>();
	for (const { projectItemId, words: sourceWords } of sources) {
		for (const clip of clipsByItem.get(projectItemId) ?? []) {
			const { id, trimStart, duration, retime } = clip;
			const rate = retime?.rate;
			const cached = wordCache?.get(id);
			const clipWords =
				cached?.sourceWords === sourceWords &&
				cached.trimStart === trimStart &&
				cached.duration === duration &&
				cached.rate === rate
					? cached.words
					: wordsInClip({ clip, sourceWords });
			if (wordCache) {
				usedClips.add(id);
				if (cached?.words !== clipWords)
					wordCache.set(id, {
						sourceWords,
						trimStart,
						duration,
						rate,
						words: clipWords,
					});
			}
			const clipStart = mediaTimeToSeconds({ time: clip.startTime });
			for (const word of clipWords) {
				const start = clipStart + word.start;
				const end = clipStart + word.end;
				const key = `${projectItemId}:${word.index}:${Math.round(start * 1000)}`;
				if (end <= start || seen.has(key)) continue;
				seen.add(key);
				words.push({
					start,
					end,
					text: word.text,
					ref: { projectItemId, index: word.index },
					clipId: clip.id,
				});
			}
		}
	}
	if (wordCache)
		for (const id of wordCache.keys())
			if (!usedClips.has(id)) wordCache.delete(id);
	return words.sort((a, b) => a.start - b.start);
}

/** Groups words into short captions that break at punctuation and pauses. */
export function buildCaptionCues({
	words,
	style = {},
}: {
	words: Array<Pick<TimelineWord, "start" | "end" | "text">>;
	style?: CaptionStyle;
}): SubtitleCue[] {
	const limit = style.wordsPerCaption ?? DEFAULT_WORDS_PER_CAPTION;
	const groups: (typeof words)[] = [];
	let current: typeof words = [];
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
	return mergeShortCues({ cues });
}

/** A caption too short to read joins the one that follows it straight away. */
function mergeShortCues({ cues }: { cues: SubtitleCue[] }): SubtitleCue[] {
	const merged: SubtitleCue[] = [];
	for (const cue of cues) {
		const previous = merged.at(-1);
		if (
			previous &&
			previous.duration < MIN_CAPTION_SECONDS - 1e-9 &&
			cue.startTime - (previous.startTime + previous.duration) < 1e-6
		) {
			merged[merged.length - 1] = {
				...previous,
				text: `${previous.text} ${cue.text}`,
				duration: cue.startTime + cue.duration - previous.startTime,
			};
		} else merged.push(cue);
	}
	return merged;
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
	wordsUntil = until,
}: {
	content: SequenceTracks;
	captions: CaptionsRequest;
	canvasSize: { width: number; height: number };
	from?: number;
	/** Captions end by here. */
	until?: number;
	/** Only words starting before here are captioned. */
	wordsUntil?: number;
}): TextTrack["clips"] {
	const words = mapWordsToTimeline({
		tracks: content,
		sources: captions.sources,
	}).filter(({ start }) => start >= from && start < wordsUntil);
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
export function uncaptionedItemIds({
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

	const seconds = (time: number) => mediaTimeToSeconds({ time: roundMediaTime({ time }) });
	let before = previous.clips.filter(
		(clip) => clip.startTime + clip.duration <= window.start,
	);
	// Captions of words that share a start show one after another, so a run of
	// them can straddle the window's edge. A staggered caption starts at no
	// word's start; if one continues straight after the kept captions, rebuild
	// its whole run rather than keep part of it and lose its other words.
	const oldWords = mapWordsToTimeline({
		tracks: withoutCaptionTrack({ tracks: sequence.tracks }),
		sources: captions.sources,
	});
	// Starts that several words share, in order (the words are sorted).
	const sharedStarts = oldWords.flatMap(({ start }, index) =>
		Math.abs(start - (oldWords[index + 1]?.start ?? Number.NaN)) <
			SAME_TIME_SECONDS &&
		!(Math.abs(start - (oldWords[index - 1]?.start ?? Number.NaN)) <
			SAME_TIME_SECONDS)
			? [start]
			: [],
	);
	/** The latest start before `at` that several words share. */
	const runStartBefore = (at: number) =>
		sharedStarts.findLast((start) => start < at - SAME_TIME_SECONDS);
	/**
	 * Whether a caption starting here is a later caption of a run of words
	 * that share a start: after the run's start, before its hold ends, and at
	 * no word's own start.
	 */
	const isStaggered = (time: number) => {
		const at = seconds(time);
		const runStart = runStartBefore(at);
		if (runStart === undefined) return false;
		const runEnd =
			Math.max(
				...oldWords
					.filter(({ start }) => start >= runStart - SAME_TIME_SECONDS && start < at)
					.map(({ end }) => end),
			) + CAPTION_HOLD_SECONDS;
		return (
			at < runEnd - SAME_TIME_SECONDS &&
			!oldWords.some(({ start }) => Math.abs(start - at) < SAME_TIME_SECONDS)
		);
	};
	const keptEnd = Math.max(
		0,
		...before.map((clip) => seconds(clip.startTime + clip.duration)),
	);
	const keptBefore = new Set(before);
	// Cheap checks first: only a caption at the kept captions' end can be
	// part of a run that crosses the edge.
	const runCrosses = previous.clips.some(
		(clip) =>
			Math.abs(seconds(clip.startTime) - keptEnd) < SAME_TIME_SECONDS &&
			!keptBefore.has(clip) &&
			isStaggered(clip.startTime),
	);
	const runStart = runStartBefore(keptEnd);
	if (runCrosses && runStart !== undefined)
		before = before.filter(
			(clip) => seconds(clip.startTime) < runStart - SAME_TIME_SECONDS,
		);
	const later = previous.clips
		.filter((clip) => clip.startTime >= window.end)
		.sort((a, b) => a.startTime - b.startTime);
	// The same on the far edge: a staggered caption that continues straight
	// after a caption the edit replaced belongs to a run being rebuilt.
	const keptAfter = new Set(later);
	const replacedEndsAt = (time: number) =>
		previous.clips.some(
			(clip) =>
				Math.abs(seconds(clip.startTime + clip.duration) - seconds(time)) <
					SAME_TIME_SECONDS && !keptAfter.has(clip),
		);
	for (const clip of later) {
		if (!replacedEndsAt(clip.startTime) || !isStaggered(clip.startTime)) break;
		keptAfter.delete(clip);
	}
	const after = later
		.filter((clip) => keptAfter.has(clip))
		.map((clip) => ({
		...clip,
		startTime: roundMediaTime({ time: clip.startTime + window.delta }),
	}));
	// Fresh captions fill the gap between the kept ones. They caption the
	// words heard from the last kept caption to the end of the edit, or of the
	// last caption it replaced if that ran later. Later words keep theirs,
	// even one the creator moved off its word.
	const from = Math.max(
		0,
		...before.map((clip) => seconds(clip.startTime + clip.duration)),
	);
	const until = Math.min(
		Number.POSITIVE_INFINITY,
		...after.map((clip) => seconds(clip.startTime)),
	);
	const replacedEnd = Math.max(
		seconds(window.end + window.delta),
		...previous.clips
			.filter(
				(clip) =>
					!keptBefore.has(clip) &&
					!keptAfter.has(clip) &&
					clip.startTime + clip.duration > window.end,
			)
			.map((clip) => seconds(clip.startTime + clip.duration + window.delta)),
	);
	// The first kept caption may have been moved later than its own word, so
	// the latest word before it, when the edit spans that word, stays its.
	const lastWordBeforeKept = Number.isFinite(until)
		? mapWordsToTimeline({ tracks: content, sources: captions.sources })
				.filter(({ start }) => start <= until + SAME_TIME_SECONDS)
				.at(-1)?.start
		: undefined;
	const keptWordStart =
		lastWordBeforeKept !== undefined &&
		lastWordBeforeKept >= seconds(window.start) - SAME_TIME_SECONDS
			? lastWordBeforeKept
			: until;
	const between = captionClips({
		content,
		captions,
		canvasSize,
		from,
		until,
		wordsUntil: Math.min(until, replacedEnd, keptWordStart),
	});
	return {
		...content,
		overlay: [
			{ ...previous, clips: [...before, ...between, ...after] },
			...content.overlay,
		],
	};
}
