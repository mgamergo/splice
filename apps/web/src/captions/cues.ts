/**
 * Horizontal SRT captions. Cues are derived, never stored: the transcript
 * words heard in the sequence are corrected, grouped into readable phrases
 * and timed against the sequence, so they follow every cut and take swap.
 */
import {
	type CaptionCueSummary,
	type CaptionScope,
	type CaptionWordRef,
	type CueEdit,
	MAX_CUE_TEXT_CHARS,
	MAX_REPLACEMENT_CHARS,
	type ProjectCaptions,
	type Replacement,
} from "@splice/bridge/delivery";
import { type ClipWordCache, mapWordsToTimeline } from "@/agent/captions";
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

export const SENTENCE_END = /[.!?…]["'’”)\]]*$/u;
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

/** What one stretch of a cue shows, and where its text came from. */
export interface CuePart {
	text: string;
	/** The transcript's words. */
	original: string;
	correctedBy?: CaptionScope;
	/** The cue edit that wrote this text. */
	edit?: CueEdit;
}

/**
 * A cue as the editor uses it: the summary plus the words it covers, each
 * with the clip it is heard through, and the parts its text is made of.
 */
export interface CaptionCue extends CaptionCueSummary {
	words: Required<CaptionWordRef>[];
	parts: CuePart[];
}

/** One word, or several words a correction joined, on the sequence. */
interface Token extends CuePart {
	start: number;
	end: number;
	words: CaptionCue["words"];
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

/** Whether placed words are the ones an edit names, through the clips it names. */
function editMatch({
	placed,
	edit,
}: {
	placed: CaptionWordRef[];
	edit: CueEdit;
}): "placement" | "words" | null {
	if (!sameRefs({ a: placed, b: edit.words })) return null;
	return edit.words.every(
		(ref, i) => !ref.clipId || ref.clipId === placed[i].clipId,
	)
		? "placement"
		: "words";
}

const hasPlacement = (edit: CueEdit) =>
	edit.words.every(({ clipId }) => clipId !== undefined);

/**
 * Replaces the run of words each cue edit names with the creator's text, at
 * the placement the edit was made on, so a repeat of the same words keeps
 * its own captions. When a split moved the words to a new clip, the edit
 * follows them if they are heard only once.
 */
function applyCueEdits({
	tokens,
	edits,
	sequenceId,
	clipIds,
}: {
	tokens: Token[];
	edits: CueEdit[];
	sequenceId?: string;
	/** The clips on the sequence. */
	clipIds: Set<string>;
}): Token[] {
	const relevant = edits.filter(
		(edit) => !edit.sequenceId || edit.sequenceId === sequenceId,
	);
	if (!relevant.length) return tokens;
	const startsAt = new Map<string, number[]>();
	for (const [i, token] of tokens.entries()) {
		const key = refKey(token.words[0]);
		startsAt.set(key, [...(startsAt.get(key) ?? []), i]);
	}
	const placedClaims = new Map<number, CueEdit>();
	const legacyClaims = new Map<number, CueEdit>();
	for (const edit of relevant) {
		const placements: number[] = [];
		const elsewhere: number[] = [];
		for (const i of startsAt.get(refKey(edit.words[0])) ?? []) {
			const match = editMatch({
				placed: tokens.slice(i, i + edit.words.length).flatMap((t) => t.words),
				edit,
			});
			if (match === "placement") placements.push(i);
			else if (match === "words") elsewhere.push(i);
		}
		// A removed clip takes its edits with it; a split one keeps its id.
		const followsSplit =
			elsewhere.length === 1 &&
			edit.words.every(({ clipId }) => !clipId || clipIds.has(clipId));
		const claims = hasPlacement(edit) ? placedClaims : legacyClaims;
		for (const i of placements.length ? placements : followsSplit ? elsewhere : [])
			if (!claims.has(i)) claims.set(i, edit);
	}
	// A placed edit overrides any legacy edit covering the same words here.
	const placedWords = new Set<number>();
	for (const [start, edit] of placedClaims)
		for (let i = start; i < start + edit.words.length; i++) placedWords.add(i);
	for (const [start, edit] of legacyClaims)
		if (!edit.words.some((_, offset) => placedWords.has(start + offset)))
			placedClaims.set(start, edit);

	const result: Token[] = [];
	for (let i = 0; i < tokens.length; ) {
		const edit = placedClaims.get(i);
		if (!edit) {
			result.push(tokens[i]);
			i++;
			continue;
		}
		const run = tokens.slice(i, i + edit.words.length);
		result.push({
			...join({ tokens: run, scope: "cue", text: edit.text }),
			edit,
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

/**
 * Whether a replacement may join two neighbouring words: not across a pause
 * that ends a phrase, a sentence end the replacement doesn't name itself, or
 * a change of recording.
 */
function joinable({
	before,
	after,
	said,
}: {
	before: Token;
	after: Token;
	/** The replacement's word matched to `before`. */
	said: string;
}): boolean {
	return (
		after.start - before.end < PAUSE_SECONDS &&
		(!SENTENCE_END.test(before.text) || SENTENCE_END.test(said)) &&
		before.words.at(-1)?.projectItemId === after.words[0].projectItemId
	);
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
			said: words(replacement.from),
			match: words(replacement.from).map(normalizeWord),
		}))
		.filter(({ match }) => match.length && match.every(Boolean))
		// The longest match wins where several start at one word.
		.sort((a, b) => b.match.length - a.match.length);
	if (!patterns.length) return tokens;
	const result: Token[] = [];
	for (let i = 0; i < tokens.length; ) {
		const pattern = patterns.find(({ match, said }) =>
			match.every((word, offset) => {
				const token = tokens[i + offset];
				return (
					token !== undefined &&
					(!token.correctedBy || token.correctedBy === over) &&
					normalizeWord(token.text) === word &&
					(offset === 0 ||
						joinable({
							before: tokens[i + offset - 1],
							after: token,
							said: said[offset - 1],
						}))
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
	sequenceId,
	wordCache,
}: {
	tracks: SequenceTracks;
	captions: ProjectCaptions | undefined;
	spellings?: Replacement[];
	/** Seconds; no cue runs past it. */
	sequenceEnd: number;
	/** The sequence the tracks belong to; cue edits made on others don't apply. */
	sequenceId?: string;
	wordCache?: ClipWordCache;
}): CaptionCue[] {
	if (!captions?.sources.length) {
		wordCache?.clear();
		return [];
	}
	let tokens: Token[] = mapWordsToTimeline({
		tracks,
		sources: captions.sources,
		wordCache,
	})
		.filter(({ start }) => start < sequenceEnd)
		.map(({ start, end, text, ref, clipId }) => ({
			start,
			end,
			text,
			original: text,
			words: [{ ...ref, clipId }],
		}));
	const clipIds = new Set(
		[tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((track) =>
			track.clips.map(({ id }) => id),
		),
	);
	tokens = applyCueEdits({
		tokens,
		edits: captions.cueEdits,
		sequenceId,
		clipIds,
	});
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
			parts: group.map(({ text, original, correctedBy, edit }) => ({
				text,
				original,
				...(correctedBy && { correctedBy }),
				...(edit && { edit }),
			})),
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
export function cuesToSrt(
	cues: Array<Pick<CaptionCue, "start" | "end" | "text">>,
	{ preserveOverlaps = false } = {},
): string {
	const blocks: string[] = [];
	let previousEnd = 0;
	for (const cue of cues) {
		if (!cue.text) continue;
		const start = Math.max(preserveOverlaps ? 0 : previousEnd, Math.round(cue.start * 1000));
		const end = Math.max(start + 1, Math.round(cue.end * 1000));
		previousEnd = end;
		blocks.push(
			`${blocks.length + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${wrapCueText(cue.text)}\n`,
		);
	}
	return blocks.join("\n");
}

/** Drops the punctuation both ends of a change share. */
function trimSharedPunctuation({ from, to }: Replacement): Replacement {
	const punctuation = /[\p{P}]/u;
	while (from && to && from.at(-1) === to.at(-1) && punctuation.test(from.at(-1) ?? ""))
		[from, to] = [from.slice(0, -1), to.slice(0, -1)];
	while (from && to && from[0] === to[0] && punctuation.test(from[0]))
		[from, to] = [from.slice(1), to.slice(1)];
	return { from: from.trim(), to: to.trim() };
}

/** Where `before` and `after` differ, in words: the shared words around a change. */
function wordChange({ a, b }: { a: string[]; b: string[] }) {
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
	return { prefix, suffix };
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
	const { prefix, suffix } = wordChange({ a, b });
	const { from, to } = trimSharedPunctuation({
		from: a.slice(prefix, a.length - suffix).join(" "),
		to: b.slice(prefix, b.length - suffix).join(" "),
	});
	if (!from || !to || !normalizeWord(from) || from === to) return null;
	return { from, to };
}

/**
 * The words a project or spelling correction changes, traced back to the
 * transcript: re-correcting words an earlier correction or spelling wrote
 * corrects the transcript's words that one replaced, so the new wording
 * takes over from it instead of naming words the transcript never says.
 */
export function correctionWords({
	cue,
	text,
}: {
	cue: Pick<CaptionCue, "text" | "parts">;
	text: string;
}): Replacement | null {
	const plain = changedWords({ before: cue.text, after: text });
	if (!plain) return null;
	const a = words(cue.text);
	const b = words(text);
	// The part of the cue each of its words comes from.
	const partOf = cue.parts.flatMap((part, k) => words(part.text).map(() => k));
	if (partOf.length !== a.length) return plain;
	const { prefix, suffix } = wordChange({ a, b });
	if (prefix >= a.length - suffix) return plain;
	const first = partOf[prefix];
	const last = partOf[a.length - suffix - 1];
	const covered = cue.parts.slice(first, last + 1);
	if (
		!covered.some(
			({ correctedBy }) => correctedBy === "project" || correctedBy === "spelling",
		) ||
		covered.some(({ correctedBy }) => correctedBy === "cue")
	)
		return plain;
	// Widen the change to whole parts, so it names the words they replaced.
	const start = partOf.indexOf(first);
	const end = partOf.lastIndexOf(last) + 1;
	const { to } = trimSharedPunctuation({
		from: a.slice(start, end).join(" "),
		to: b.slice(start, b.length - (a.length - end)).join(" "),
	});
	const from = covered
		.map(({ original }) => original)
		.join(" ")
		.replace(EDGE_PUNCTUATION, "");
	if (!to || !normalizeWord(from)) return plain;
	return { from, to };
}

export class CaptionCorrectionError extends Error {}

const ruleKey = (from: string) => words(from).map(normalizeWord).join(" ");

/** Replaces the rule for the same words, or drops it when `to` puts them back. */
function withRule({
	rules,
	replacement,
}: {
	rules: Replacement[];
	replacement: Replacement;
}): Replacement[] {
	const others = rules.filter(
		({ from }) => ruleKey(from) !== ruleKey(replacement.from),
	);
	return replacement.to === replacement.from ? others : [...others, replacement];
}

/**
 * The project's corrections without one for a spelling's words, which would
 * hide the spelling in this project; null when there is none.
 */
export function withoutRuleFor({
	captions,
	spelling,
}: {
	captions: ProjectCaptions;
	spelling: Replacement;
}): ProjectCaptions | null {
	const replacements = captions.replacements.filter(
		({ from }) => ruleKey(from) !== ruleKey(spelling.from),
	);
	return replacements.length === captions.replacements.length
		? null
		: { ...captions, replacements };
}

/**
 * What a correction changes. A cue correction stores the creator's text for
 * the cue's words at this placement on this sequence. Project and spelling
 * corrections replace the words that changed wherever they appear; a
 * spelling is also kept for future projects.
 */
export function planCorrection({
	cue,
	text,
	scope,
	captions,
	sequenceId,
}: {
	cue: CaptionCue;
	text: string;
	scope: CaptionScope;
	captions: ProjectCaptions;
	/** The sequence the cue is on. */
	sequenceId?: string;
}):
	| { scope: "cue"; captions: ProjectCaptions }
	| { scope: "project"; captions: ProjectCaptions; replacement: Replacement }
	| { scope: "spelling"; replacement: Replacement } {
	const corrected = text.replace(/\s+/g, " ").trim();
	if (scope === "cue") {
		if (corrected.length > MAX_CUE_TEXT_CHARS)
			throw new CaptionCorrectionError(
				`A caption can hold at most ${MAX_CUE_TEXT_CHARS.toLocaleString("en-US")} characters; this one has ${corrected.length.toLocaleString("en-US")}.`,
			);
		const shaping = new Set(cue.parts.flatMap(({ edit }) => (edit ? [edit] : [])));
		const atThisPlacement = (ref: CaptionWordRef) =>
			cue.words.some(
				(word) =>
					refKey(word) === refKey(ref) &&
					(!ref.clipId || ref.clipId === word.clipId),
			);
		// Other placements of the same words keep their own edits.
		const overlaps = (edit: CueEdit) =>
			shaping.has(edit) ||
			((!edit.sequenceId || edit.sequenceId === sequenceId) &&
				edit.words.some(atThisPlacement));
		const others = captions.cueEdits.filter(
			(edit) => !hasPlacement(edit) || !overlaps(edit),
		);
		// Restoring the transcript needs an override if a legacy edit still applies.
		const restores =
			corrected === (cue.originalText ?? cue.text) &&
			cue.correctedBy === "cue" &&
			!others.some((edit) => !hasPlacement(edit) && overlaps(edit));
		return {
			scope,
			captions: {
				...captions,
				cueEdits: restores
					? others
					: [
							...others,
							{
								...(sequenceId && { sequenceId }),
								words: cue.words,
								text: corrected,
							},
						],
			},
		};
	}
	const replacement = correctionWords({ cue, text: corrected });
	if (!replacement)
		throw new CaptionCorrectionError(
			"Change at least one word to correct it everywhere. To add or remove words, correct this cue only.",
		);
	if (
		replacement.from.length > MAX_REPLACEMENT_CHARS ||
		replacement.to.length > MAX_REPLACEMENT_CHARS
	)
		throw new CaptionCorrectionError(
			`A correction everywhere replaces at most ${MAX_REPLACEMENT_CHARS} characters. Change fewer words at once, or correct this cue only.`,
		);
	if (scope === "spelling") return { scope, replacement };
	return {
		scope,
		replacement,
		captions: {
			...captions,
			replacements: withRule({ rules: captions.replacements, replacement }),
		},
	};
}
