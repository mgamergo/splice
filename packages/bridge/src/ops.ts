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

const takeSourceRangeSchema = z
	.strictObject({
		projectItemId: z.string().min(1),
		sourceIn: z.number().nonnegative().describe("Source in point in seconds"),
		sourceOut: z.number().positive().describe("Source out point in seconds"),
		label: z.string().optional(),
		transcriptSnippet: z.string().optional(),
	})
	.refine((take) => take.sourceOut > take.sourceIn, {
		path: ["sourceOut"],
		message: "Source out must be after source in",
	});

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

const captionWordSchema = z.strictObject({
	start: z.number().nonnegative(),
	end: z.number().nonnegative(),
	text: z.string(),
});

/** Source-relative word timings of one recording, from its transcript. */
const captionSourceSchema = z.strictObject({
	projectItemId: z.string().min(1),
	words: z.array(captionWordSchema).max(200_000),
});

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use #rrggbb");

export const captionStyleSchema = z.strictObject({
	wordsPerCaption: z
		.number()
		.int()
		.min(1)
		.max(8)
		.optional()
		.describe("Most words shown at once (default 3)"),
	fontFamily: z.string().min(1).max(100).optional(),
	fontSize: z
		.number()
		.positive()
		.max(40)
		.optional()
		.describe("Editor text units, relative to the canvas height (default 8)"),
	color: hexColor.optional().describe("Text color (default #ffffff)"),
	background: z
		.union([hexColor, z.literal("none")])
		.optional()
		.describe('Box behind the words, or "none" (default #000000)'),
	position: z
		.enum(["top", "middle", "bottom"])
		.optional()
		.describe("Vertical placement (default bottom, clear of the Shorts UI)"),
	uppercase: z.boolean().optional(),
});

export const captionsRequestSchema = z.strictObject({
	sources: z.array(captionSourceSchema).min(1),
	style: captionStyleSchema.optional(),
});

export const roughCutRequestSchema = z.strictObject({
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
		.min(1),
	captions: captionsRequestSchema
		.optional()
		.describe(
			"Word timings for burned-in captions. splice mcp fills this for Short projects.",
		),
});

export const addCaptionsRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe("Sequence to caption. Defaults to the active sequence."),
	expectedRevision,
	...captionsRequestSchema.shape,
});

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
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionsRequest = z.infer<typeof captionsRequestSchema>;

export type TakeSourceRange = z.infer<typeof takeSourceRangeSchema>;
export type RemovalMarkerData = z.infer<typeof removalMarkerDataSchema>;
export type TimeSpec = z.infer<typeof timeSpecSchema>;
export type EditOp = z.infer<typeof editOpSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
