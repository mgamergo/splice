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

export const removalMarkerDataSchema = z.strictObject({
	kind: z.literal("removal"),
	sectionName: z.string().trim().min(1),
	bestTake: takeSourceRangeSchema,
	badTakes: z.array(takeSourceRangeSchema).min(1),
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

export type TakeSourceRange = z.infer<typeof takeSourceRangeSchema>;
export type RemovalMarkerData = z.infer<typeof removalMarkerDataSchema>;
export type TimeSpec = z.infer<typeof timeSpecSchema>;
export type EditOp = z.infer<typeof editOpSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
