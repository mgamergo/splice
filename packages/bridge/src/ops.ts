import { z } from "zod";

export const timeSpecSchema = z.union([
	z.strictObject({ seconds: z.number().nonnegative() }),
	z.strictObject({ frame: z.number().int().nonnegative() }),
	z.strictObject({ timecode: z.string().min(1) }),
]);

const rangeSchema = z.strictObject({
	start: timeSpecSchema,
	end: timeSpecSchema,
});

const sourceRangeFields = {
	projectItemId: z.string().min(1),
	sourceIn: z.number().nonnegative().describe("Source in point in seconds"),
	sourceOut: z.number().positive().describe("Source out point in seconds"),
};
const sourceOutAfterIn = (range: { sourceIn: number; sourceOut: number }) =>
	range.sourceOut > range.sourceIn;
const sourceOutMessage = {
	path: ["sourceOut"],
	message: "Source out must be after source in",
};

const sourceRangeSchema = z
	.strictObject(sourceRangeFields)
	.refine(sourceOutAfterIn, sourceOutMessage);

const takeSourceRangeSchema = z
	.strictObject({
		...sourceRangeFields,
		label: z.string().optional(),
		transcriptSnippet: z.string().optional(),
	})
	.refine(sourceOutAfterIn, sourceOutMessage);

// Keep the original single-range marker shape readable on disk.
const takeSchema = z.union([
	takeSourceRangeSchema,
	z.strictObject({
		ranges: z
			.array(takeSourceRangeSchema)
			.min(2)
			.describe(
				"Consecutive source ranges in recording order for one take spanning files",
			),
		label: z.string().optional(),
		transcriptSnippet: z.string().optional(),
	}),
]);

const takePlacementSchema = z.strictObject({
	trackId: z.string().min(1),
	audioTrackId: z.string().min(1).optional(),
});

export const removalMarkerDataSchema = z.strictObject({
	kind: z.literal("removal"),
	sectionName: z.string().trim().min(1),
	bestTake: takeSchema,
	badTakes: z.array(takeSchema).min(1),
	// A stored take can retain its original layers when it was swapped out.
	badTakePlacements: z
		.array(z.array(takePlacementSchema).nullable())
		.optional(),
});

export const editOpSchema = z.discriminatedUnion("op", [
	z.strictObject({
		op: z.literal("ripple_delete"),
		ranges: z.array(rangeSchema).min(1),
	}),
	z.strictObject({
		op: z.literal("razor"),
		at: timeSpecSchema,
		/** Clips to cut. Defaults to every clip under `at`. */
		clipIds: z.array(z.string().min(1)).min(1).optional(),
	}),
	z.strictObject({
		op: z.literal("delete"),
		clipIds: z.array(z.string().min(1)).min(1),
	}),
	z.strictObject({
		op: z.literal("add_marker"),
		at: timeSpecSchema,
		note: z.string().optional(),
		duration: timeSpecSchema.optional(),
		data: removalMarkerDataSchema.optional(),
	}),
	z.strictObject({
		op: z.literal("restore_takes"),
		markerId: z.string().min(1),
		takeIndex: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Zero-based stored take index. Omit to restore all."),
	}),
	z.strictObject({
		op: z.literal("swap_take"),
		markerId: z.string().min(1),
		takeIndex: z.number().int().nonnegative(),
	}),
]);

export const applyRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.describe(
			"The id of the sequence the ops were planned against, from the digest",
		),
	expectedRevision: z
		.number()
		.int()
		.nonnegative()
		.describe("The revision the ops were planned against, from the digest"),
	label: z
		.string()
		.min(1)
		.max(120)
		.describe('Short undo label shown to the creator, e.g. "Remove bad takes"'),
	ops: z.array(editOpSchema).min(1),
});

const expectedRevision = applyRequestSchema.shape.expectedRevision;

export const rawSequenceRequestSchema = z.strictObject({
	expectedRevision,
	projectItemIds: z
		.array(z.string().min(1))
		.min(1)
		.max(200)
		.describe("Project item IDs in recording order, earliest first"),
});

export const DEFAULT_PAUSE_PADDING_SECONDS = 0.2;

const roughCutBaseSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe('Source sequence ID. Defaults to the sequence named "Raw".'),
	expectedRevision,
	label: applyRequestSchema.shape.label.optional(),
	sections: z
		.array(
			z.strictObject({
				name: z.string().trim().min(1),
				takes: z.array(takeSchema).min(2),
				bestTakeIndex: z
					.number()
					.int()
					.nonnegative()
					.describe("Zero-based index of the take to keep"),
			}),
		)
		.default([])
		.describe(
			"Sections with retakes. Omit or pass [] when nothing was retaken.",
		),
	falseStarts: z
		.array(sourceRangeSchema)
		.default([])
		.describe(
			"Abandoned phrases to cut, in source seconds: from the false start's first word to the first word of its restart. Whisper's word times drift by up to half a second, so when a pause from detect_pauses sits next to an edge, put the edge inside that pause: Splice snaps it to the pause and keeps the breath padding.",
		),
	pausePaddingSeconds: z
		.number()
		.min(0)
		.max(1)
		.default(DEFAULT_PAUSE_PADDING_SECONDS)
		.describe(
			"Silence kept on each side of a removed pause, in seconds. Defaults to 0.2.",
		),
});

/** What the agent sends to `rough_cut`. `splice` resolves pauses and fillers before the tab sees it. */
export const roughCutRequestSchema = roughCutBaseSchema.extend({
	pauses: z
		.union([z.literal("auto"), z.array(sourceRangeSchema)])
		.default("auto")
		.describe(
			'"auto" (the default) removes the pauses detect_pauses finds in every recording on the source sequence. Or pass silence ranges with project item IDs, or [] to keep every pause.',
		),
	pauseDetection: z
		.strictObject({
			noiseDb: z.number().min(-90).max(-10).optional(),
			minSeconds: z.number().min(0.2).max(10).optional(),
		})
		.optional()
		.describe('detect_pauses settings for pauses: "auto".'),
	removeFillerWords: z
		.boolean()
		.default(false)
		.describe(
			"Also cut English filler words (um, uh, erm…) found in the cached transcripts. Off by default.",
		),
});

/** What the tab applies: every tightening range is explicit. */
export const roughCutPlanSchema = roughCutBaseSchema.extend({
	pauses: z.array(sourceRangeSchema).default([]),
	fillerWords: z.array(sourceRangeSchema).default([]),
});

export const roughCutSourcesRequestSchema = roughCutBaseSchema.pick({
	sequenceId: true,
});

/** The recordings on a rough cut's source sequence, as `editor.roughCutSources` reports them. */
export const roughCutSourcesSchema = z.discriminatedUnion("ok", [
	z.object({
		ok: z.literal(true),
		sequenceId: z.string(),
		items: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				/** Null for items that don't reference a file under Footage. */
				path: z.string().nullable(),
			}),
		),
	}),
	z.object({
		ok: z.literal(false),
		code: z.string(),
		message: z.string(),
		revision: z.number(),
	}),
]);

export const takesListRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe("Sequence to inspect. Defaults to the active sequence."),
});

export type TakePlacement = z.infer<typeof takePlacementSchema>;
export type Take = z.infer<typeof takeSchema>;
export type RoughCutRequest = z.infer<typeof roughCutRequestSchema>;
export type RoughCutPlan = z.infer<typeof roughCutPlanSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type RoughCutSources = z.infer<typeof roughCutSourcesSchema>;

export type TakeSourceRange = z.infer<typeof takeSourceRangeSchema>;
export type RemovalMarkerData = z.infer<typeof removalMarkerDataSchema>;
export type TimeSpec = z.infer<typeof timeSpecSchema>;
export type EditOp = z.infer<typeof editOpSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
