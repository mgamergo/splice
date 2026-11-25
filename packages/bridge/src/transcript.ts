/**
 * The cut transcript: the narration heard in a sequence as sentences and
 * paragraphs on the sequence's time, and the passage the creator selected in
 * it to direct the editing agent.
 */
import { z } from "zod";

export const cutTranscriptRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe("Sequence whose transcript to read. Defaults to the active one."),
});

export const transcriptSelectionRequestSchema = z.strictObject({});

/** One sentence as the transcript panel and `cut_transcript` show it. Seconds on the sequence. */
export interface TranscriptSentenceSummary {
	id: string;
	start: number;
	end: number;
	text: string;
}

export interface TranscriptParagraphSummary {
	/** The removal marker's section when the paragraph is a kept take. */
	section?: { markerId: string; name: string };
	sentences: TranscriptSentenceSummary[];
}

/** The sentences the creator selected, as one passage on the sequence. */
export interface TranscriptSelectionSummary {
	sequenceId: string;
	sequenceName: string;
	start: number;
	end: number;
	text: string;
	sentences: TranscriptSentenceSummary[];
}

export type CutTranscriptRequest = z.infer<typeof cutTranscriptRequestSchema>;
