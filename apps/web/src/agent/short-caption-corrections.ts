import { captionsRequestSchema, captionStyleSchema } from "@splice/bridge/ops";
import { z } from "zod";
import type { TextClip } from "@/timeline/types";

const sourceWordSchema = z.object({
	projectItemId: z.string(),
	index: z.number().int().nonnegative(),
	start: z.number(),
	end: z.number(),
});
const correctionSchema = z.object({
	words: z.array(sourceWordSchema).nonempty(),
	text: z.string(),
});

export const savedShortCaptionsSchema = captionsRequestSchema.extend({
	corrections: z.array(correctionSchema).optional(),
	/** Style fields explicitly set on this sequence. Older saves stored only these fields. */
	explicitStyle: captionStyleSchema.optional(),
});

export type SavedShortCaptions = z.infer<typeof savedShortCaptionsSchema>;
export type CaptionPart = z.infer<typeof correctionSchema>;
type TimedPart = CaptionPart & { start: number; end: number };

export const captionWordKey = ({
	projectItemId,
	index,
	start,
	end,
}: CaptionPart["words"][number]) =>
	JSON.stringify([projectItemId, index, start, end]);
const plainText = (text: string) => text.trim().replace(/\s+/g, " ");
const splitWords = (text: string) => (text ? text.split(" ") : []);

/** Keeps edits on the source words they replace, even when cues are regrouped. */
export function recordCaptionCorrections({
	clips,
	corrections = [],
}: {
	clips: TextClip[];
	corrections?: CaptionPart[];
}): CaptionPart[] {
	let saved = corrections;
	for (const { captionLayout, params } of clips) {
		if (!captionLayout?.parts?.length) continue;
		const parts = captionLayout.parts.map((part) => ({
			...part,
			text: plainText(part.text),
		}));
		const before = plainText(captionLayout.text);
		let after = plainText(String(params.content ?? ""));
		if (before === after) continue;

		// Replacing individual parts lets unchanged neighbours regroup normally.
		const editedWords = splitWords(after);
		const changes: CaptionPart[] = [];
		if (splitWords(before).length === editedWords.length) {
			let offset = 0;
			for (const part of parts) {
				const original = part.text;
				const end = offset + splitWords(original).length;
				const text = editedWords.slice(offset, end).join(" ");
				if (text !== original) changes.push({ words: part.words, text });
				offset = end;
			}
		} else {
			// Keep insertions and deletions together with their source words.
			let first = 0;
			let last = parts.length;
			while (
				first + 1 < last &&
				(after === parts[first].text ||
					after.startsWith(parts[first].text + " "))
			) {
				after = after.slice(parts[first].text.length).trimStart();
				first++;
			}
			while (
				first + 1 < last &&
				(after === parts[last - 1].text ||
					after.endsWith(" " + parts[last - 1].text))
			) {
				after = after.slice(0, -parts[last - 1].text.length).trimEnd();
				last--;
			}
			changes.push({
				words: parts.slice(first, last).flatMap(({ words }) => words),
				text: after,
			});
		}
		const changed = new Set(
			changes.flatMap(({ words }) => words.map(captionWordKey)),
		);
		saved = [
			...saved.filter(
				({ words }) => !words.some((word) => changed.has(captionWordKey(word))),
			),
			...changes,
		];
	}
	return saved;
}

export function applyCaptionCorrections({
	parts,
	corrections = [],
}: {
	parts: TimedPart[];
	corrections?: CaptionPart[];
}): TimedPart[] {
	if (!corrections.length) return parts;
	const byStart = new Map(
		corrections.map((part) => [captionWordKey(part.words[0]), part]),
	);
	const corrected: TimedPart[] = [];
	for (let index = 0; index < parts.length; ) {
		const part = parts[index];
		const edit = byStart.get(captionWordKey(part.words[0]));
		if (
			!edit ||
			!edit.words.every((word, offset) => {
				const next = parts[index + offset];
				return next && captionWordKey(next.words[0]) === captionWordKey(word);
			})
		) {
			corrected.push(part);
			index++;
			continue;
		}
		const run = parts.slice(index, index + edit.words.length);
		if (edit.text)
			corrected.push({
				...edit,
				start: part.start,
				end: Math.max(...run.map(({ end }) => end)),
			});
		index += edit.words.length;
	}
	return corrected;
}
