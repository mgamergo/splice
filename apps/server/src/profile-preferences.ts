import { z } from "zod";

const evidenceIds = z.array(z.uuid()).min(1).max(16);
const seconds = z.number().min(0).max(10);
const takeCriteria = z.enum(["completeness", "fluency", "pacing"]);
const preferenceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("take_order"),
		value: z.tuple([takeCriteria, takeCriteria, takeCriteria]),
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("minimum_pause_seconds"),
		value: seconds,
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("pause_padding_seconds"),
		value: seconds,
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("filler_words"),
		value: z.enum(["keep", "remove_aligned"]),
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("false_starts"),
		value: z.enum(["keep", "remove"]),
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("captions"),
		value: z.enum(["word_by_word", "phrase_by_phrase", "off"]),
		evidenceIds,
	}),
	z.strictObject({
		kind: z.literal("framing"),
		value: z.enum(["wider", "closer"]),
		evidenceIds,
	}),
]);
export type Preference = z.infer<typeof preferenceSchema>;

const questionTopic = z.enum([
	"take_order",
	"minimum_pause_seconds",
	"pause_padding_seconds",
	"filler_words",
	"false_starts",
	"captions",
	"framing",
]);
const questions: Record<z.infer<typeof questionTopic>, string> = {
	take_order:
		"Which matters most when choosing a take: completeness, fluency, or pacing?",
	minimum_pause_seconds:
		"How long should a pause be before Splice tightens it?",
	pause_padding_seconds:
		"How much breathing room should Splice leave on each side of a tightened pause?",
	filler_words:
		"Should Splice keep filler words or remove ones aligned to the audio?",
	false_starts: "Should Splice keep false starts or remove them?",
	captions:
		"Do you prefer word-by-word captions, phrase-by-phrase captions, or no captions?",
	framing: "Do you prefer wider or closer framing?",
};

export const analysisResultSchema = z.strictObject({
	preferences: z.array(preferenceSchema).max(7),
	question: questionTopic.nullable(),
});

export function validateAnalysis({
	result,
	evidence,
}: {
	result: unknown;
	evidence: Set<string>;
}) {
	const { preferences, question } = analysisResultSchema.parse(result);
	if (new Set(preferences.map(({ kind }) => kind)).size !== preferences.length)
		throw new Error(
			"A profile analysis must propose at most one value per preference.",
		);
	for (const preference of preferences) {
		if (preference.evidenceIds.some((id) => !evidence.has(id)))
			throw new Error(
				"A preference references evidence outside its analysis batch.",
			);
		if (
			preference.kind === "take_order" &&
			new Set(preference.value).size !== 3
		)
			throw new Error("Take ranking must include every criterion once.");
		preference.evidenceIds = [...new Set(preference.evidenceIds)].sort();
	}
	return { preferences, question: question ? questions[question] : null };
}

export const entrySchema = z.union([
	preferenceSchema,
	z.strictObject({ kind: z.literal("manual"), value: z.string() }),
]);
export type ProfileEntry = z.infer<typeof entrySchema>;

export const changeSchema = z
	.strictObject({
		before: entrySchema.nullable(),
		after: entrySchema.nullable(),
	})
	.refine(
		({ before, after }) =>
			(before || after) && (!before || !after || before.kind === after.kind),
	);
export type PreferenceChange = z.infer<typeof changeSchema>;

export const EMPTY_PROFILE = `# Editing profile

No preferences have been learned yet.

## Take selection

## Tightening
`;

export function manualEntries(text: string): ProfileEntry[] {
	return text === EMPTY_PROFILE ? [] : [{ kind: "manual", value: text }];
}

function describe(preference: Preference) {
	switch (preference.kind) {
		case "take_order":
			return `Take ranking order: ${preference.value.join(", ")}`;
		case "minimum_pause_seconds":
			return `Minimum pause to tighten: ${preference.value} seconds`;
		case "pause_padding_seconds":
			return `Padding on each side of a tightened pause: ${preference.value} seconds`;
		case "filler_words":
			return `Filler words: ${preference.value === "keep" ? "keep" : "remove aligned fillers"}`;
		case "false_starts":
			return `False starts: ${preference.value}`;
		case "captions":
			return `Captions: ${preference.value}`;
		case "framing":
			return `Framing: ${preference.value}`;
	}
}

export function renderProfile(entries: ProfileEntry[]) {
	const manual = entries.find(({ kind }) => kind === "manual");
	const preferences = entries
		.filter((entry) => entry.kind !== "manual")
		.sort((a, b) => a.kind.localeCompare(b.kind, "en"));
	if (!preferences.length) return manual?.value ?? EMPTY_PROFILE;
	const learned = preferences.map(
		(preference) =>
			`- ${describe(preference)} (evidence: ${preference.evidenceIds.join(", ")})`,
	);
	const automatic = ["## Learned editing preferences", "", ...learned, ""].join(
		"\n",
	);
	return manual
		? `${manual.value}\n\n${automatic}`
		: `# Editing profile\n\n${automatic}`;
}

export function changeKind(change: PreferenceChange) {
	return (change.before ?? change.after)?.kind;
}

export function preferenceChanges({
	before,
	after,
}: {
	before: ProfileEntry[];
	after: ProfileEntry[];
}): PreferenceChange[] {
	const previous = new Map(before.map((entry) => [entry.kind, entry]));
	const next = new Map(after.map((entry) => [entry.kind, entry]));
	return [...new Set([...previous.keys(), ...next.keys()])].flatMap((kind) => {
		const before = previous.get(kind) ?? null;
		const after = next.get(kind) ?? null;
		return JSON.stringify(before) === JSON.stringify(after)
			? []
			: [{ before, after }];
	});
}
