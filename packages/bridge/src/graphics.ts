/**
 * The basic graphics pass: zooms, highlights and glass cards the agent plans
 * against the recordings, and how a sequence stores them so the creator's
 * changes survive reruns, cuts and take swaps.
 */
import { z } from "zod";
import { expectedRevision } from "./revision";

export const GRAPHIC_KINDS = ["zoom", "highlight", "card"] as const;
export type GraphicKind = (typeof GRAPHIC_KINDS)[number];

const sourceSeconds = z
	.number()
	.nonnegative()
	.max(24 * 60 * 60);

/** A rectangle on the recording's frame, as fractions of its width and height. */
export const targetRectSchema = z
	.strictObject({
		x: z.number().min(0).max(1),
		y: z.number().min(0).max(1),
		width: z.number().gt(0).max(1),
		height: z.number().gt(0).max(1),
	})
	.refine(
		({ x, y, width, height }) => x + width <= 1.0001 && y + height <= 1.0001,
		{ message: "The target must lie inside the frame" },
	);

export const plannedGraphicSchema = z
	.strictObject({
		key: z
			.string()
			.trim()
			.min(1)
			.max(200)
			.optional()
			.describe(
				'Stable name for this graphic across passes, e.g. "zoom:settings-button". A rerun with the same key updates it instead of adding another. Defaults to its kind, recording and action time.',
			),
		kind: z
			.enum(GRAPHIC_KINDS)
			.describe(
				'"zoom" magnifies the recording around the target, "highlight" draws a box around it, "card" shows a glass card with an explanation the recording can\'t show.',
			),
		projectItemId: z
			.string()
			.min(1)
			.describe("The recording that shows the action, from items_list"),
		passage: z
			.strictObject({
				projectItemId: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Recording that carries the narration when it differs from the picture",
					),
				start: sourceSeconds,
				end: sourceSeconds,
				text: z
					.string()
					.max(2000)
					.optional()
					.describe(
						"The narration the graphic illustrates, from the transcript",
					),
			})
			.refine(({ start, end }) => end > start, {
				message: "The passage must end after it starts",
			})
			.describe(
				"The spoken passage, in source seconds of its narration recording",
			),
		action: sourceSeconds
			.optional()
			.describe(
				"Source second of the on-screen action the graphic points at, such as the click. The graphic follows it through cuts and take swaps. Defaults to passage.start.",
			),
		start: sourceSeconds
			.optional()
			.describe(
				"Source second the graphic appears. Defaults to passage.start.",
			),
		end: sourceSeconds
			.optional()
			.describe("Source second the graphic clears. Defaults to passage.end."),
		target: targetRectSchema
			.optional()
			.describe(
				"The control or detail on the recording's frame, as fractions (0–1) of its width and height. Required for zoom and highlight; optional for a card, which then sits away from it.",
			),
		confidence: z
			.enum(["high", "low"])
			.default("high")
			.describe(
				'"low" when you are unsure the target is right: a zoom or highlight is then left out and the shot stays wide.',
			),
		title: z.string().trim().max(80).optional().describe("A card's title"),
		text: z
			.string()
			.trim()
			.max(400)
			.optional()
			.describe(
				"A card's explanation. Ground it in the recording or the creator's notes.",
			),
		creatorDirected: z
			.boolean()
			.optional()
			.describe(
				"Set for a Raw explanatory card only when the creator explicitly requested the card.",
			),
		maxZoom: z
			.number()
			.min(1)
			.max(4)
			.optional()
			.describe("The most a zoom may magnify. Defaults to 2.5."),
	})
	.superRefine((graphic, context) => {
		if (graphic.kind === "card" && !graphic.title && !graphic.text)
			context.addIssue({
				code: "custom",
				path: ["text"],
				message: "A card needs a title or text",
			});
		if (
			graphic.kind !== "card" &&
			graphic.confidence === "high" &&
			!graphic.target
		)
			context.addIssue({
				code: "custom",
				path: ["target"],
				message: `A ${graphic.kind} needs a target, or confidence "low" to leave the shot wide`,
			});
		const start = graphic.start ?? graphic.passage.start;
		const end = graphic.end ?? graphic.passage.end;
		if (end <= start)
			context.addIssue({
				code: "custom",
				path: ["end"],
				message: "The graphic must clear after it appears",
			});
	});

const sequenceId = z
	.string()
	.min(1)
	.optional()
	.describe(
		"The active sequence's id, from sequence_get. Defaults to the active one.",
	);

const passFields = {
	graphics: z
		.array(plannedGraphicSchema)
		.max(200)
		.describe("The planned graphics, in any order"),
	prune: z
		.boolean()
		.default(false)
		.describe(
			"Also remove graphics from earlier passes that this plan no longer lists. Graphics the creator adjusted are kept.",
		),
};

export const graphicsPlanRequestSchema = z.strictObject({
	sequenceId,
	...passFields,
});

export const graphicsApplyRequestSchema = z.strictObject({
	sequenceId,
	...passFields,
	expectedRevision,
	label: z
		.string()
		.min(1)
		.max(120)
		.optional()
		.describe(
			'Undo label shown to the creator. Defaults to "Agent: graphics pass".',
		),
});

export const graphicsPassOpSchema = z.strictObject({
	op: z.literal("graphics_pass"),
	...passFields,
});

export const graphicsListRequestSchema = z.strictObject({
	sequenceId,
});

export type PlannedGraphic = z.infer<typeof plannedGraphicSchema>;
export type GraphicsPlanRequest = z.infer<typeof graphicsPlanRequestSchema>;
export type GraphicsApplyRequest = z.infer<typeof graphicsApplyRequestSchema>;
export type TargetRect = z.infer<typeof targetRectSchema>;

const pointSchema = z.strictObject({ x: z.number(), y: z.number() });

/**
 * A graphic's adjustable properties. Times are seconds, `start` measured from
 * its action on the sequence; position is canvas pixels from the center.
 */
const graphicValuesSchema = z.strictObject({
	start: z.number().finite(),
	duration: z.number().finite().positive(),
	position: pointSchema.optional(),
	scale: z.number().optional(),
	scaleY: z.number().optional(),
	text: z.string().optional(),
});

export const GRAPHIC_PROPERTIES = [
	"start",
	"duration",
	"position",
	"scale",
	"scaleY",
	"text",
	"hidden",
] as const;
export type GraphicProperty = (typeof GRAPHIC_PROPERTIES)[number];

/** Values the creator set by hand, one property at a time. */
const graphicOverridesSchema = graphicValuesSchema.partial().extend({
	hidden: z.boolean().optional(),
});

export const GRAPHIC_FLAG_CODES = [
	"action_missing",
	"action_covered",
	"passage_changed",
	"zoom_conflict",
	"timing_outside_picture",
	"action_obscured",
] as const;
export type GraphicFlagCode = (typeof GRAPHIC_FLAG_CODES)[number];

const graphicFlagSchema = z.strictObject({
	code: z.enum(GRAPHIC_FLAG_CODES),
	message: z.string().max(500),
});

export const graphicRecordSchema = z.strictObject({
	id: z.string().min(1),
	key: z.string().min(1),
	kind: z.enum(GRAPHIC_KINDS),
	creatorDirected: z.boolean().optional(),
	/** The narration it illustrates. */
	passage: z.strictObject({
		projectItemId: z.string().min(1),
		start: sourceSeconds,
		end: sourceSeconds,
		text: z.string().max(2000).optional(),
	}),
	/** The source frame of its action: the recording and the time in it. */
	action: z.strictObject({
		projectItemId: z.string().min(1),
		time: sourceSeconds,
	}),
	target: targetRectSchema.optional(),
	/** Planned display interval in source seconds, before any creator timing edits. */
	sourceInterval: z
		.strictObject({ start: sourceSeconds, end: z.number().finite() })
		.optional(),
	/** What the agent planned. */
	planned: graphicValuesSchema,
	overrides: graphicOverridesSchema,
	/** What the last placement wrote to the sequence; absent while it's off the sequence. */
	placed: graphicValuesSchema
		.extend({
			clipId: z.string().min(1),
			hidden: z.boolean(),
			/** Where its action sat on the sequence, in seconds. */
			anchor: z.number().finite(),
		})
		.optional(),
	flags: z.array(graphicFlagSchema).max(10),
});

/** A graphic the creator deleted. Later passes don't bring it back. */
export const graphicTombstoneSchema = z.strictObject({
	key: z.string().min(1),
	kind: z.enum(GRAPHIC_KINDS),
	projectItemId: z.string().min(1),
	action: sourceSeconds,
});

export const sequenceGraphicsSchema = z.strictObject({
	records: z.array(graphicRecordSchema),
	tombstones: z.array(graphicTombstoneSchema),
	/** The picture clips as of the last placement, so cuts aren't read as adjustments. */
	screen: z.string().max(64).optional(),
});

export type GraphicValues = z.infer<typeof graphicValuesSchema>;
export type GraphicOverrides = z.infer<typeof graphicOverridesSchema>;
export type GraphicFlag = z.infer<typeof graphicFlagSchema>;
export type GraphicRecord = z.infer<typeof graphicRecordSchema>;
export type GraphicTombstone = z.infer<typeof graphicTombstoneSchema>;
export type SequenceGraphics = z.infer<typeof sequenceGraphicsSchema>;
