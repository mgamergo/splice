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

/** Clip volume bounds in dB, matching the editor's volume control. */
export const CLIP_GAIN_DB = { min: -60, max: 20 } as const;
export const DEFAULT_TARGET_LUFS = -14;
/** Normalization never pushes the measured true peak above this. */
export const MAX_TRUE_PEAK_DBTP = -1;

const gainDbSchema = z
	.number()
	.min(CLIP_GAIN_DB.min)
	.max(CLIP_GAIN_DB.max)
	.describe("Clip volume in dB; 0 plays the source at its own level");

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
	z.strictObject({
		op: z.literal("set_gain"),
		clipIds: z.array(z.string().min(1)).min(1),
		gainDb: gainDbSchema,
	}),
	z.strictObject({
		op: z.literal("set_noise_reduction"),
		clipIds: z.array(z.string().min(1)).min(1),
		enabled: z
			.boolean()
			.describe(
				"Play and export these clips' audio from splice's noise-reduced render of the recording",
			),
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

const targetLufs = z
	.number()
	.min(-40)
	.max(-5)
	.optional()
	.describe(
		`Integrated loudness target in LUFS. Defaults to ${DEFAULT_TARGET_LUFS}.`,
	);

const loudnessOption = z
	.union([z.strictObject({ targetLufs }), z.literal(false)])
	.optional()
	.describe(
		`Normalizes each recording's kept audio to ${DEFAULT_TARGET_LUFS} LUFS, or targetLufs, in the same undo step. Pass false to keep source levels.`,
	);

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
	loudness: loudnessOption,
	noiseReduction: z
		.boolean()
		.optional()
		.describe(
			"Turns noise reduction on for every recording in the cut, in the same undo step. Off by default.",
		),
});

const sourceGainSchema = z.strictObject({
	projectItemId: z.string().min(1),
	gainDb: gainDbSchema,
});

/**
 * What `splice` sends the tab for `rough_cut`. With `plan`, the tab builds the
 * cut without applying it and returns its audio sources, so `splice` can
 * measure them and send `sourceGains` with the same request.
 */
export const roughCutTabRequestSchema = roughCutRequestSchema
	.omit({ loudness: true })
	.extend({
		plan: z.boolean().optional(),
		sourceGains: z.array(sourceGainSchema).optional(),
	});

export const audioSourcesRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe("Sequence to inspect. Defaults to the active sequence."),
});

export const normalizeLoudnessRequestSchema = z.strictObject({
	expectedRevision,
	targetLufs,
	label: applyRequestSchema.shape.label.optional(),
});

export const noiseReductionRequestSchema = z.strictObject({
	expectedRevision,
	enabled: z.boolean().describe("true turns noise reduction on, false off"),
	projectItemIds: z
		.array(z.string().min(1))
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Recordings to change. Defaults to every recording heard in the active sequence.",
		),
	loudness: loudnessOption,
	label: applyRequestSchema.shape.label.optional(),
});

export const sourceRangeSchema = z
	.strictObject({
		start: z.number().nonnegative().describe("Source seconds"),
		end: z.number().positive().describe("Source seconds"),
	})
	.refine((range) => range.end > range.start, {
		path: ["end"],
		message: "End must be after start",
	});

/** Sorts and merges source ranges, so the same audio always reads the same. */
export function mergeSourceRanges(
	ranges: Array<z.infer<typeof sourceRangeSchema>>,
): Array<z.infer<typeof sourceRangeSchema>> {
	const merged: Array<z.infer<typeof sourceRangeSchema>> = [];
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last && range.start <= last.end)
			last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

/** The audible audio of one project item in a sequence, in source seconds. */
export const audioSourceSchema = z.strictObject({
	projectItemId: z.string(),
	/** The Footage path, or null for items stored in the browser. */
	path: z.string().nullable(),
	/** Whether these clips play the noise-reduced render. */
	noiseReduction: z.boolean(),
	clipIds: z.array(z.string()),
	/** Sorted, merged source ranges. */
	ranges: z.array(sourceRangeSchema),
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
export type SourceGain = z.infer<typeof sourceGainSchema>;
export type NoiseReductionRequest = z.infer<typeof noiseReductionRequestSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type AudioSource = z.infer<typeof audioSourceSchema>;

export type TakeSourceRange = z.infer<typeof takeSourceRangeSchema>;
export type RemovalMarkerData = z.infer<typeof removalMarkerDataSchema>;
export type TimeSpec = z.infer<typeof timeSpecSchema>;
export type EditOp = z.infer<typeof editOpSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
