/**
 * Horizontal SRT captions. Cues are derived, never stored: the transcript
 * words heard in the sequence are corrected, grouped into readable phrases
 * and timed against the sequence, so they follow every cut and take swap.
 */
import type {
	CaptionCueSummary,
	CaptionScope,
	CaptionWordRef,
	CueEdit,
	ProjectCaptions,
	Replacement,
} from "@splice/bridge/delivery";
import { mapWordsToTimeline } from "@/agent/captions";
import type { SequenceTracks } from "@/timeline/types";

/** YouTube and broadcast guidance: two lines of at most 42 characters. */
export const MAX_LINE_CHARS = 42;
const MAX_CUE_CHARS = 2 * MAX_LINE_CHARS;
const MAX_CUE_SECONDS = 6;
/** A short cue stays up this long when the silence after it allows. */
const MIN_CUE_SECONDS = 1;
/** How long a cue stays after its last word, unless the next one starts. */
const HOLD_SECONDS = 0.25;
/** A silence this long between words ends a phrase. */
const PAUSE_SECONDS = 0.6;
/** Past this length, a comma or similar ends the cue. */
const CLAUSE_CHARS = 50;
/** A cue split to fit keeps at least this much before the split. */
const MIN_SPLIT_CHARS = 24;
/** Cues starting this close together are shown as one (stacked word times). */
const SAME_START_SECONDS = 0.05;

const SENTENCE_END = /[.!?…]["'’”)\]]*$/u;
const CLAUSE_END = /[,;:—–]["'’”)\]]*$/u;
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;
/** Words a phrase can start with, so a long cue may break before them. */
const CONNECTIVES = new Set([
	"and",
	"but",
	"or",
	"so",
	"because",
	"which",
	"that",
	"when",
	"where",
	"if",
	"then",
	"while",
	"until",
	"before",
	"after",
	"since",
	"although",
	"though",
	"unless",
]);

/** A cue as the editor uses it: the summary plus the words it covers. */
export interface CaptionCue extends CaptionCueSummary {
	words: CaptionWordRef[];
}

/** One word, or several words a correction joined, on the sequence. */
interface Token {
	start: number;
	end: number;
	text: string;
	/** The transcript's words. */
	original: string;
	words: CaptionWordRef[];
	correctedBy?: CaptionScope;
	/** A cue the creator corrected stays a cue of its own. */
	wholeCue?: boolean;
}

export function normalizeWord(text: string): string {
	return text.replace(EDGE_PUNCTUATION, "").toLowerCase();
}

function words(text: string): string[] {
	return text.trim().split(/\s+/).filter(Boolean);
}

const refKey = ({ projectItemId, index }: CaptionWordRef) =>
	`${projectItemId}:${index}`;

function sameRefs({
	a,
	b,
}: {
	a: CaptionWordRef[];
	b: CaptionWordRef[];
}): boolean {
	return a.length === b.length && a.every((ref, i) => refKey(ref) === refKey(b[i]));
}

/** One token for several, with a correction's text or theirs. */
function join({
	tokens,
	scope,
	text,
}: {
	tokens: Token[];
	scope?: CaptionScope;
	text?: string;
}): Token {
	const original = tokens.map((token) => token.original).join(" ");
	return {
		start: tokens[0].start,
		end: Math.max(...tokens.map((token) => token.end)),
		text: text ?? tokens.map((token) => token.text).join(" "),
		original,
		words: tokens.flatMap((token) => token.words),
		correctedBy: scope,
	};
}

/** Replaces each run of words a cue edit names with the creator's text. */
function applyCueEdits({
	tokens,
	edits,
}: {
	tokens: Token[];
	edits: CueEdit[];
}): Token[] {
	if (!edits.length) return tokens;
	const byFirst = new Map<string, CueEdit[]>();
	for (const edit of edits) {
		const key = refKey(edit.words[0]);
		byFirst.set(key, [...(byFirst.get(key) ?? []), edit]);
	}
	const result: Token[] = [];
	for (let i = 0; i < tokens.length; ) {
		const edit = byFirst.get(refKey(tokens[i].words[0]))?.find((candidate) =>
			sameRefs({
				a: tokens.slice(i, i + candidate.words.length).flatMap((t) => t.words),
				b: candidate.words,
			}),
		);
		if (!edit) {
			result.push(tokens[i]);
			i++;
			continue;
		}
		const run = tokens.slice(i, i + edit.words.length);
		result.push({
			...join({ tokens: run, scope: "cue", text: edit.text }),
			wholeCue: true,
		});
		i += run.length;
	}
	return result;
}

/** The replacement text with the punctuation around the words it replaces. */
function withEdgePunctuation({
	text,
	first,
	last,
}: {
	text: string;
	first: string;
	last: string;
}): string {
	const leading = /^[\p{Ps}\p{Pi}"'¿¡]+/u.exec(first)?.[0] ?? "";
	const trailing = /[\p{P}]+$/u.exec(last)?.[0] ?? "";
	const start = text.startsWith(leading) ? "" : leading;
	const end = text.endsWith(trailing) ? "" : trailing;
	return `${start}${text}${end}`;
}

/** Joins every run of words matching a replacement's words into its text. */
function applyReplacements({
	tokens,
	replacements,
	scope,
	over,
}: {
	tokens: Token[];
	replacements: Replacement[];
	scope: CaptionScope;
	/** Corrections of this kind may be corrected again. */
	over?: CaptionScope;
}): Token[] {
	const patterns = replacements
		.map((replacement) => ({
			...replacement,
			match: words(replacement.from).map(normalizeWord),
		}))
		.filter(({ match }) => match.length && match.every(Boolean))
		// The longest match wins where several start at one word.
		.sort((a, b) => b.match.length - a.match.length);
	if (!patterns.length) return tokens;
	const result: Token[] = [];
	for (let i = 0; i < tokens.length; ) {
		const pattern = patterns.find(({ match }) =>
			match.every((word, offset) => {
				const token = tokens[i + offset];
				return (
					token !== undefined &&
					(!token.correctedBy || token.correctedBy === over) &&
					normalizeWord(token.text) === word
				);
			}),
		);
		if (!pattern) {
			result.push(tokens[i]);
			i++;
			continue;
		}
		const run = tokens.slice(i, i + pattern.match.length);
		result.push(
			join({
				tokens: run,
				scope,
				text: withEdgePunctuation({
					text: pattern.to,
					first: run[0].text,
					last: run.at(-1)?.text ?? "",
				}),
			}),
		);
		i += run.length;
	}
	return result;
}

const length = (tokens: Token[]) =>
	tokens.reduce((sum, token) => sum + token.text.length, 0) +
	Math.max(0, tokens.length - 1);

/**
 * Where to split a cue that grew too long: after the latest clause, or else
 * before the latest connective, leaving a readable first part.
 */
function bestSplit(tokens: Token[]): number {
	const at = (isBreak: (k: number) => boolean) => {
		for (let k = tokens.length - 1; k >= 1; k--) {
			if (length(tokens.slice(0, k)) < MIN_SPLIT_CHARS) return 0;
			if (isBreak(k)) return k;
		}
		return 0;
	};
	return (
		at((k) => CLAUSE_END.test(tokens[k - 1].text)) ||
		at((k) => CONNECTIVES.has(normalizeWord(tokens[k].text)))
	);
}

/** Groups words into phrases: sentences, pauses, clauses, then length. */
function groupTokens(tokens: Token[]): Token[][] {
	const groups: Token[][] = [];
	let current: Token[] = [];
	const tooLong = (next: Token) =>
		current.length > 0 &&
		(length([...current, next]) > MAX_CUE_CHARS ||
			next.end - current[0].start > MAX_CUE_SECONDS);
	for (const token of tokens) {
		const previous = current.at(-1);
		if (
			previous &&
			(token.wholeCue ||
				previous.wholeCue ||
				token.start - previous.end >= PAUSE_SECONDS ||
				SENTENCE_END.test(previous.text) ||
				(CLAUSE_END.test(previous.text) && length(current) >= CLAUSE_CHARS))
		) {
			groups.push(current);
			current = [];
		} else if (tooLong(token)) {
			const split = bestSplit(current);
			groups.push(split ? current.slice(0, split) : current);
			current = split ? current.slice(split) : [];
			if (tooLong(token)) {
				groups.push(current);
				current = [];
			}
		}
		current.push(token);
	}
	if (current.length) groups.push(current);
	// whisper.cpp can stack several words on one time; one cue shows them.
	const merged: Token[][] = [];
	for (const group of groups) {
		const previous = merged.at(-1);
		if (
			previous &&
			!previous[0].wholeCue &&
			!group[0].wholeCue &&
			group[0].start - previous[0].start < SAME_START_SECONDS
		)
			merged[merged.length - 1] = [...previous, ...group];
		else merged.push(group);
	}
	return merged;
}

function cueIds(cues: Array<{ words: CaptionWordRef[] }>): string[] {
	const seen = new Map<string, number>();
	return cues.map(({ words: refs }) => {
		const first = refs[0];
		const last = refs.at(-1) ?? first;
		const base =
			first.projectItemId === last.projectItemId
				? `${first.projectItemId}:${first.index}-${last.index}`
				: `${refKey(first)}-${refKey(last)}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		// A repeated source range captions each repeat.
		return count === 1 ? base : `${base}#${count}`;
	});
}

/**
 * The cues of a sequence: the words heard on it, with the creator's cue
 * edits, the project's corrections and the reusable spellings.
 */
export function buildCaptionCues({
	tracks,
	captions,
	spellings = [],
	sequenceEnd,
}: {
	tracks: SequenceTracks;
	captions: ProjectCaptions | undefined;
	spellings?: Replacement[];
	/** Seconds; no cue runs past it. */
	sequenceEnd: number;
}): CaptionCue[] {
	if (!captions?.sources.length) return [];
	let tokens: Token[] = mapWordsToTimeline({
		tracks,
		sources: captions.sources,
	})
		.filter(({ start }) => start < sequenceEnd)
		.map(({ start, end, text, ref }) => ({
			start,
			end,
			text,
			original: text,
			words: [ref],
		}));
	tokens = applyCueEdits({ tokens, edits: captions.cueEdits });
	// The project's corrections win over reusable spellings, whether they name
	// the transcript's words or a spelling's.
	const project = { replacements: captions.replacements, scope: "project" } as const;
	tokens = applyReplacements({ tokens, ...project });
	tokens = applyReplacements({
		tokens,
		replacements: spellings,
		scope: "spelling",
	});
	tokens = applyReplacements({ tokens, ...project, over: "spelling" });
	const groups = groupTokens(tokens);
	const ids = cueIds(groups.map((group) => ({ words: group.flatMap((t) => t.words) })));
	return groups.map((group, index) => {
		const start = group[0].start;
		const lastEnd = Math.max(...group.map((token) => token.end));
		const next = groups[index + 1]?.[0].start ?? Number.POSITIVE_INFINITY;
		const end = Math.max(
			start + 0.001,
			Math.min(
				next,
				sequenceEnd,
				Math.max(lastEnd + HOLD_SECONDS, start + MIN_CUE_SECONDS),
			),
		);
		const text = group
			.map((token) => token.text)
			.filter(Boolean)
			.join(" ");
		const originalText = group.map((token) => token.original).join(" ");
		const correctedBy =
			group.find((token) => token.correctedBy === "cue")?.correctedBy ??
			group.find((token) => token.correctedBy === "project")?.correctedBy ??
			group.find((token) => token.correctedBy)?.correctedBy;
		return {
			id: ids[index],
			index: index + 1,
			start,
			end,
			text,
			...(text !== originalText && { originalText }),
			...(correctedBy && { correctedBy }),
			words: group.flatMap((token) => token.words),
		};
	});
}

/** The cue showing at `time`, if any. */
export function cueAt({
	cues,
	time,
}: {
	cues: CaptionCue[];
	time: number;
}): CaptionCue | undefined {
	return cues.find((cue) => cue.text && cue.start <= time && time < cue.end);
}

/** Wraps a cue into lines of at most 42 characters, balancing two lines. */
export function wrapCueText(text: string): string {
	if (text.length <= MAX_LINE_CHARS) return text;
	const parts = words(text);
	if (text.length <= MAX_CUE_CHARS) {
		let best = -1;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let k = 1; k < parts.length; k++) {
			const top = parts.slice(0, k).join(" ");
			const bottom = parts.slice(k).join(" ");
			if (top.length > MAX_LINE_CHARS || bottom.length > MAX_LINE_CHARS)
				continue;
			// Even lines, nudged towards breaking after punctuation.
			const score =
				Math.abs(top.length - bottom.length) -
				(CLAUSE_END.test(parts[k - 1]) || SENTENCE_END.test(parts[k - 1])
					? 12
					: 0);
			if (score < bestScore) {
				bestScore = score;
				best = k;
			}
		}
		if (best > 0)
			return `${parts.slice(0, best).join(" ")}\n${parts.slice(best).join(" ")}`;
	}
	const lines: string[] = [];
	for (const part of parts) {
		const line = lines.at(-1);
		if (line !== undefined && line.length + 1 + part.length <= MAX_LINE_CHARS)
			lines[lines.length - 1] = `${line} ${part}`;
		else lines.push(part);
	}
	return lines.join("\n");
}

export function formatSrtTime(milliseconds: number): string {
	const ms = Math.max(0, Math.round(milliseconds));
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${String(ms % 1000).padStart(3, "0")}`;
}

/** SRT for the cues with text, numbered from 1, in whole milliseconds. */
export function cuesToSrt(cues: CaptionCue[]): string {
	const blocks: string[] = [];
	let previousEnd = 0;
	for (const cue of cues) {
		if (!cue.text) continue;
		const start = Math.max(previousEnd, Math.round(cue.start * 1000));
		const end = Math.max(start + 1, Math.round(cue.end * 1000));
		previousEnd = end;
		blocks.push(
			`${blocks.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${wrapCueText(cue.text)}\n`,
		);
	}
	return blocks.join("\n");
}

/** The words a correction changed: what differs once shared words and punctuation are trimmed. */
export function changedWords({
	before,
	after,
}: {
	before: string;
	after: string;
}): Replacement | null {
	const a = words(before);
	const b = words(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
		prefix++;
	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	)
		suffix++;
	let from = a.slice(prefix, a.length - suffix).join(" ");
	let to = b.slice(prefix, b.length - suffix).join(" ");
	const punctuation = /[\p{P}]/u;
	while (from && to && from.at(-1) === to.at(-1) && punctuation.test(from.at(-1) ?? ""))
		[from, to] = [from.slice(0, -1), to.slice(0, -1)];
	while (from && to && from[0] === to[0] && punctuation.test(from[0]))
		[from, to] = [from.slice(1), to.slice(1)];
	from = from.trim();
	to = to.trim();
	if (!from || !to || !normalizeWord(from) || from === to) return null;
	return { from, to };
}

export class CaptionCorrectionError extends Error {}

/**
 * What a correction changes. A cue correction stores the creator's text for
 * the cue's words. Project and spelling corrections replace the words that
 * changed wherever they appear; a spelling is also kept for future projects.
 */
export function planCorrection({
	cue,
	text,
	scope,
	captions,
}: {
	cue: CaptionCue;
	text: string;
	scope: CaptionScope;
	captions: ProjectCaptions;
}):
	| { scope: "cue"; captions: ProjectCaptions }
	| { scope: "project"; captions: ProjectCaptions; replacement: Replacement }
	| { scope: "spelling"; replacement: Replacement } {
	const corrected = text.replace(/\s+/g, " ").trim();
	if (scope === "cue") {
		const covered = new Set(cue.words.map(refKey));
		const others = captions.cueEdits.filter(
			(edit) => !edit.words.some((ref) => covered.has(refKey(ref))),
		);
		// Typing the transcript's words back removes the edit.
		const restores =
			corrected === (cue.originalText ?? cue.text) && cue.correctedBy === "cue";
		return {
			scope,
			captions: {
				...captions,
				cueEdits: restores
					? others
					: [...others, { words: cue.words, text: corrected }],
			},
		};
	}
	const replacement = changedWords({ before: cue.text, after: corrected });
	if (!replacement)
		throw new CaptionCorrectionError(
			"Change at least one word to correct it everywhere. To add or remove words, correct this cue only.",
		);
	if (scope === "spelling") return { scope, replacement };
	const key = (from: string) => words(from).map(normalizeWord).join(" ");
	return {
		scope,
		replacement,
		captions: {
			...captions,
			replacements: [
				...captions.replacements.filter(
					({ from }) => key(from) !== key(replacement.from),
				),
				replacement,
			],
		},
	};
}
