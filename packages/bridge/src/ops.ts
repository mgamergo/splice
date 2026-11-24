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

const itemRangeSchema = z
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
	/**
	 * The clip volume in dB the take played at when it was swapped out, so it
	 * keeps its recording's gain even once no other clip of that recording is left.
	 */
	volume: z.number().optional(),
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
		.array(itemRangeSchema)
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

const sourceGainSchema = z.strictObject({
	projectItemId: z.string().min(1),
	gainDb: gainDbSchema,
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

export const sourceRangeSchema = z
	.strictObject({
		start: z.number().nonnegative().describe("Source seconds"),
		end: z.number().positive().describe("Source seconds"),
	})
	.refine((range) => range.end > range.start, {
		path: ["end"],
		message: "End must be after start",
	});

/** The audible audio of one project item in a sequence, in source seconds. */
export const audioSourceSchema = z.strictObject({
	projectItemId: z.string(),
	/** The Footage path, or null for items stored in the browser. */
	path: z.string().nullable(),
	/** The file has left Footage, so playback skips it until it's relinked. */
	missing: z.boolean(),
	clipIds: z.array(z.string()),
	/**
	 * Source ranges, one per clip in the order they play, so repeated audio
	 * counts each time and joins are measured as heard.
	 */
	ranges: z.array(sourceRangeSchema),
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

/** What the agent sends to `rough_cut`. `splice` resolves pauses and fillers before the tab sees it. */
/** What the agent sends to `rough_cut`. `splice` resolves pauses and fillers before the tab sees it. */
export const roughCutRequestSchema = roughCutBaseSchema.extend({
	pauses: z
		.union([z.literal("auto"), z.array(itemRangeSchema)])
		.default("auto")
		.describe(
			'"auto" (the default) removes the pauses detect_pauses finds in every recording heard on the source sequence, where every recording heard there is silent. Or pass silence ranges with project item IDs, or [] to keep every pause.',
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
	loudness: z
		.union([z.strictObject({ targetLufs }), z.literal(false)])
		.optional()
		.describe(
			`Normalizes each recording's kept audio to ${DEFAULT_TARGET_LUFS} LUFS, or targetLufs, in the same undo step. Pass false to keep source levels.`,
		),
	captions: captionsRequestSchema
		.optional()
		.describe(
			"Word timings for burned-in captions. splice mcp fills this for Short projects.",
		),
});

/**
 * Lets `splice mcp` build the cut in two passes. With `plan`, the tab builds
 * the cut without applying it and returns its audio sources, so `splice` can
 * measure them and send `sourceGains` with the same request.
 */
const roughCutPassFields = {
	plan: z.boolean().optional(),
	sourceGains: z.array(sourceGainSchema).optional(),
};

/** What `splice mcp` sends `splice` for `editor.roughCut`: loudness is already measured. */
export const roughCutCallSchema = roughCutRequestSchema
	.omit({ loudness: true })
	.extend(roughCutPassFields);

/** The cut itself, with every tightening range explicit. */
export const roughCutPlanSchema = roughCutBaseSchema.extend({
	pauses: z.array(itemRangeSchema).default([]),
	fillerWords: z.array(itemRangeSchema).default([]),
});

/** What `splice` sends the tab for `editor.roughCut`. */
export const roughCutTabRequestSchema = roughCutPlanSchema.extend({
	captions: captionsRequestSchema.optional(),
	...roughCutPassFields,
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
export type ItemRange = z.infer<typeof itemRangeSchema>;
export type RoughCutSources = z.infer<typeof roughCutSourcesSchema>;
export type SourceGain = z.infer<typeof sourceGainSchema>;
export type SourceRange = z.infer<typeof sourceRangeSchema>;
export type AudioSource = z.infer<typeof audioSourceSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type CaptionsRequest = z.infer<typeof captionsRequestSchema>;

export type TakeSourceRange = z.infer<typeof takeSourceRangeSchema>;
export type RemovalMarkerData = z.infer<typeof removalMarkerDataSchema>;
export type TimeSpec = z.infer<typeof timeSpecSchema>;
export type EditOp = z.infer<typeof editOpSchema>;
export type ApplyRequest = z.infer<typeof applyRequestSchema>;
