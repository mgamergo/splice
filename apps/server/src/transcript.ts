import type { Transcript, TranscriptWord } from "@splice/bridge";
import { z } from "zod";

const offsets = z.object({ from: z.number(), to: z.number() });
const whisperOutput = z.object({
	result: z.object({ language: z.string().min(1) }),
	transcription: z.array(
		z.object({
			offsets,
			text: z.string(),
			tokens: z.array(
				z.object({
					text: z.string(),
					p: z.number().min(0).max(1),
					offsets: offsets.optional(),
				}),
			),
		}),
	),
});

const timedText = z.object({
	start: z.number().nonnegative(),
	end: z.number().nonnegative(),
	text: z.string(),
});

export const transcriptSchema = z.object({
	path: z.string(),
	durationSeconds: z.number().positive(),
	language: z.string(),
	model: z.string(),
	segments: z.array(
		timedText.extend({
			words: z.array(
				timedText.extend({ probability: z.number().min(0).max(1) }),
			),
		}),
	),
}) satisfies z.ZodType<Transcript>;

export function normalizeTranscript({
	value,
	path,
	model,
	durationSeconds,
}: Omit<Transcript, "segments" | "language"> & { value: unknown }): Transcript {
	const output = whisperOutput.parse(value);
	function seconds(milliseconds: number): number {
		return Math.min(durationSeconds, Math.max(0, milliseconds / 1000));
	}

	return {
		path,
		model,
		durationSeconds,
		language: output.result.language,
		segments: output.transcription.map((segment) => {
			const start = seconds(segment.offsets.from);
			const end = Math.max(start, seconds(segment.offsets.to));
			const words: TranscriptWord[] = [];
			let pieces = 0;
			let word: TranscriptWord | undefined;
			for (const token of segment.tokens) {
				if (/^\[_.*\]$/.test(token.text)) continue;
				const text = token.text.trim();
				if (!text) continue;
				if (/^\s/.test(token.text)) word = undefined;
				// The full JSON contains subword tokens and untimed punctuation.
				// Keep punctuation with its word and average the token probabilities.
				if (!word) {
					if (!token.offsets) continue;
					const wordStart = Math.max(
						start,
						Math.min(end, seconds(token.offsets.from)),
					);
					word = { start: wordStart, end: wordStart, text: "", probability: 0 };
					words.push(word);
					pieces = 0;
				}
				word.text += text;
				word.probability += (token.p - word.probability) / ++pieces;
				if (token.offsets) {
					word.end = Math.max(
						word.end,
						Math.min(end, seconds(token.offsets.to)),
					);
				}
			}
			return { start, end, text: segment.text.trim(), words };
		}),
	};
}
