/**
 * The cut transcript: the narration heard in a sequence, read as sentences
 * and paragraphs. Like the SRT cues it is built from, it is derived, never
 * stored, so every cut, take swap and restore updates its passage.
 */
import type { FrameRate } from "opencut-wasm";
import { resolveEditRange } from "@/agent/time";
import type {
	TranscriptParagraphSummary,
	TranscriptSelectionSummary,
	TranscriptSentenceSummary,
} from "@splice/bridge/transcript";
import { type CaptionCue, SENTENCE_END } from "@/captions/cues";
import type { Marker, SequenceTracks } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

/** A silence this long between cues ends a sentence without punctuation. */
const SENTENCE_PAUSE_SECONDS = 1;
/** An unpunctuated run of speech ends a sentence at the next cue past this. */
const MAX_SENTENCE_CHARS = 240;
/** A silence this long starts a new paragraph. */
const PARAGRAPH_PAUSE_SECONDS = 1.5;
/** Paragraphs stay short enough to scan. */
const MAX_PARAGRAPH_SENTENCES = 6;

export interface TranscriptSentence extends TranscriptSentenceSummary {
	/** The SRT cues it reads, in order. */
	cueIds: string[];
	words: CaptionCue["words"];
}

export interface TranscriptParagraph
	extends Omit<TranscriptParagraphSummary, "sentences"> {
	id: string;
	sentences: TranscriptSentence[];
}

export interface CutTranscript {
	paragraphs: TranscriptParagraph[];
	/** Every sentence in sequence order. */
	sentences: TranscriptSentence[];
}

type Section = NonNullable<TranscriptParagraphSummary["section"]>;

/** Where on the sequence each removal marker's best take is heard. */
function sectionRanges({
	tracks,
	markers,
}: {
	tracks: SequenceTracks;
	markers: Marker[];
}): Array<{ start: number; end: number; section: Section }> {
	const sections = new Map<string, Section>();
	for (const marker of markers)
		if (marker.data)
			sections.set(marker.id, {
				markerId: marker.id,
				name: marker.data.sectionName,
			});
	if (!sections.size) return [];
	const ranges: Array<{ start: number; end: number; section: Section }> = [];
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio])
		for (const clip of track.clips)
			for (const markerId of clip.bestTakeMarkerIds ?? []) {
				const section = sections.get(markerId);
				if (!section) continue;
				const start = mediaTimeToSeconds({ time: clip.startTime });
				ranges.push({
					start,
					end: start + mediaTimeToSeconds({ time: clip.duration }),
					section,
				});
			}
	return ranges;
}

/** What a cue says aloud: its corrected text, or the transcript's if hidden. */
const spoken = (cue: CaptionCue) => cue.text || cue.originalText || "";

/** Each run names a clip and the source words heard through it. */
function sentenceId(cues: CaptionCue[]): string {
	const runs: [
		clipId: string,
		projectItemId: string,
		first: number,
		last: number,
	][] = [];
	for (const cue of cues)
		for (const { clipId, projectItemId, index } of cue.words) {
			const run = runs.at(-1);
			if (
				run &&
				run[0] === clipId &&
				run[1] === projectItemId &&
				run[3] + 1 === index
			)
				run[3] = index;
			else runs.push([clipId, projectItemId, index, index]);
		}
	return JSON.stringify(runs);
}

/**
 * Reads a sequence's SRT cues as sentences, breaking at sentence punctuation,
 * a recording change or a long silence, and groups them into paragraphs by
 * the take-removal section they belong to.
 */
export function buildCutTranscript({
	cues,
	tracks,
	markers,
}: {
	cues: CaptionCue[];
	tracks: SequenceTracks;
	markers: Marker[];
}): CutTranscript {
	const groups: CaptionCue[][] = [];
	let current: CaptionCue[] = [];
	for (const cue of cues) {
		if (!spoken(cue)) continue;
		const previous = current.at(-1);
		if (
			previous &&
			(SENTENCE_END.test(spoken(previous)) ||
				cue.start - previous.end >= SENTENCE_PAUSE_SECONDS ||
				cue.words[0].projectItemId !== previous.words.at(-1)?.projectItemId ||
				current.reduce((sum, c) => sum + spoken(c).length + 1, 0) >=
					MAX_SENTENCE_CHARS)
		) {
			groups.push(current);
			current = [];
		}
		current.push(cue);
	}
	if (current.length) groups.push(current);

	const sentences: TranscriptSentence[] = groups.map((group) => ({
		id: sentenceId(group),
		start: group[0].start,
		end: Math.max(...group.map((cue) => cue.end)),
		text: group.map(spoken).join(" "),
		cueIds: group.map((cue) => cue.id),
		words: group.flatMap((cue) => cue.words),
	}));

	const ranges = sectionRanges({ tracks, markers });
	const sectionAt = (time: number) =>
		ranges.find(({ start, end }) => start <= time && time < end)?.section;
	const paragraphs: TranscriptParagraph[] = [];
	let previous: { sentence: TranscriptSentence; section?: Section } | null =
		null;
	for (const sentence of sentences) {
		const section = sectionAt(sentence.start);
		const paragraph = paragraphs.at(-1);
		if (
			!paragraph ||
			!previous ||
			section?.markerId !== previous.section?.markerId ||
			// Outside sections, a new recording starts a new paragraph.
			(!section &&
				sentence.words[0].projectItemId !==
					previous.sentence.words.at(-1)?.projectItemId) ||
			sentence.start - previous.sentence.end >= PARAGRAPH_PAUSE_SECONDS ||
			paragraph.sentences.length >= MAX_PARAGRAPH_SENTENCES
		)
			paragraphs.push({
				id: sentence.id,
				...(section && { section }),
				sentences: [sentence],
			});
		else paragraph.sentences.push(sentence);
		previous = { sentence, section };
	}
	return { paragraphs, sentences };
}

/** The sentence heard at `time`, if any. */
export function sentenceAt({
	sentences,
	time,
}: {
	sentences: TranscriptSentence[];
	time: number;
}): TranscriptSentence | undefined {
	return sentences.find(({ start, end }) => start <= time && time < end);
}

/**
 * A run of sentences between two the creator picked, in sequence order.
 * Null when an edit removed either one.
 */
export function selectedSentences({
	sentences,
	anchorId,
	focusId,
}: {
	sentences: TranscriptSentence[];
	anchorId: string;
	focusId: string;
}): TranscriptSentence[] | null {
	const anchor = sentences.findIndex(({ id }) => id === anchorId);
	const focus = sentences.findIndex(({ id }) => id === focusId);
	if (anchor < 0 || focus < 0) return null;
	return sentences.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
}

/** Seconds to the millisecond, as agents read them. */
const toMs = (seconds: number) => Math.round(seconds * 1000) / 1000;

export function summarizeSentence({
	id,
	start,
	end,
	text,
}: TranscriptSentence): TranscriptSentenceSummary {
	return { id, start: toMs(start), end: toMs(end), text };
}

export function summarizeSelection({
	sequence,
	sentences,
	fps,
}: {
	sequence: { id: string; name: string };
	sentences: TranscriptSentence[];
	fps: FrameRate;
}): TranscriptSelectionSummary {
	const start = sentences[0].start;
	const end = Math.max(...sentences.map((sentence) => sentence.end));
	const bounds = resolveEditRange({
		start: { seconds: start },
		end: { seconds: end },
		fps,
	});
	return {
		sequenceId: sequence.id,
		sequenceName: sequence.name,
		start: toMs(start),
		end: toMs(end),
		editBounds: {
			start: mediaTimeToSeconds({ time: bounds.start }),
			end: mediaTimeToSeconds({ time: bounds.end }),
		},
		text: sentences.map(({ text }) => text).join(" "),
		sentences: sentences.map(summarizeSentence),
	};
}
