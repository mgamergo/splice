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
	const segmenter = new Intl.Segmenter(output.result.language, {
		granularity: "word",
	});
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
			let text = "";
			const tokens = segment.tokens.flatMap((token) => {
				if (/^\[_.*\]$/.test(token.text) || !token.text) return [];
				const from = text.length;
				text += token.text;
				return [{ ...token, from, to: text.length }];
			});
			// Use character spans to align linguistic words to Whisper's subword tokens.
			const spans: Array<{ from: number; to: number }> = [];
			for (const part of segmenter.segment(text)) {
				const to = part.index + part.segment.length;
				const previous = spans.at(-1);
				if (part.isWordLike) spans.push({ from: part.index, to });
				else if (previous?.to === part.index && !/^\s/.test(part.segment))
					previous.to = to;
			}
			let cursor = 0;
			for (const span of spans) {
				while (cursor < tokens.length && tokens[cursor].to <= span.from)
					cursor++;
				let probability = 0;
				let pieces = 0;
				let wordStart = Infinity;
				let wordEnd = start;
				for (
					let index = cursor;
					index < tokens.length && tokens[index].from < span.to;
					index++
				) {
					const token = tokens[index];
					probability += token.p;
					pieces++;
					if (token.offsets) {
						wordStart = Math.min(
							wordStart,
							Math.max(start, Math.min(end, seconds(token.offsets.from))),
						);
						wordEnd = Math.max(
							wordEnd,
							Math.min(end, seconds(token.offsets.to)),
						);
					}
				}
				if (Number.isFinite(wordStart)) {
					words.push({
						start: wordStart,
						end: Math.max(wordStart, wordEnd),
						text: text.slice(span.from, span.to),
						probability: probability / pieces,
					});
				}
			}
			return { start, end, text: segment.text.trim(), words };
		}),
	};
}
