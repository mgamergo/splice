import { z } from "zod";
import { captionStyleSchema } from "./ops";
import { expectedRevision } from "./revision";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const card = z.strictObject({
	color,
	background: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
	fontSize: z.number().positive().max(12),
	cornerRadius: z.number().min(0).max(160),
});
const highlight = z.strictObject({
	stroke: color,
	width: z.number().min(1).max(32),
	cornerRadius: z.number().min(0).max(50),
});
const zoom = z.strictObject({
	minScale: z.number().gt(1).max(4),
	maxScale: z.number().gt(1).max(4),
	rampSeconds: z.number().min(0.05).max(2),
	easing: z.enum(["bezier", "linear"]),
});
const caption = captionStyleSchema.pick({
	fontFamily: true,
	fontSize: true,
	color: true,
	background: true,
});
const short = z.strictObject({
	captionAnchor: z.enum(["top", "middle", "bottom"]),
	cardAnchor: z.enum(["auto", "top", "bottom"]),
});
const values = z.strictObject({
	card,
	highlight,
	zoom: zoom.refine(({ minScale, maxScale }) => minScale <= maxScale, {
		message: "Minimum zoom must be at most the maximum zoom.",
	}),
	caption,
	explainer: short,
	raw: short,
});
export const styleDefaultsSchema = z.strictObject({
	version: z.literal(1),
	revision: z.number().int().positive(),
	values,
});
export type StyleDefaults = z.infer<typeof styleDefaultsSchema>;

export const BASE_STYLE: StyleDefaults = {
	version: 1,
	revision: 1,
	values: {
		card: {
			color: "#ffffff",
			background: "#0f172acc",
			fontSize: 3.2,
			cornerRadius: 30,
		},
		highlight: { stroke: "#ffd60a", width: 5, cornerRadius: 12 },
		zoom: { minScale: 1.2, maxScale: 2.5, rampSeconds: 0.4, easing: "bezier" },
		caption: { fontSize: 8, color: "#ffffff", background: "#000000" },
		explainer: { captionAnchor: "middle", cardAnchor: "top" },
		raw: { captionAnchor: "bottom", cardAnchor: "auto" },
	},
};

export const setStyleDefaultsSchema = z.strictObject({
	expectedStyleRevision: z.number().int().positive(),
	card: card.partial().optional(),
	highlight: highlight.partial().optional(),
	zoom: zoom.partial().optional(),
	caption: caption
		.extend({ fontFamily: caption.shape.fontFamily.nullable() })
		.optional(),
	explainer: short.partial().optional(),
	raw: short.partial().optional(),
});
export const applyStyleUpdateSchema = z.strictObject({
	previewId: z.uuid(),
	expectedRevision,
});

const evidence = z.strictObject({
	graphicId: z.string().min(1).max(200),
	sequenceId: z.string().min(1).max(200),
	key: z.string().min(1).max(200),
	before: z.number(),
	after: z.number(),
});
export const FRAMING_THRESHOLD = 3;
export const framingKindSchema = z.enum([
	"zoom-wider",
	"zoom-closer",
	"card-top",
	"card-bottom",
]);
const framingGroupSchema = z.strictObject({
	kind: framingKindSchema,
	evidence: z.array(evidence).length(FRAMING_THRESHOLD),
});
const framingProjectId = z.string().min(1).max(200);
export const reconcileFramingSchema = z.strictObject({
	projectId: framingProjectId,
	groups: z.array(framingGroupSchema).max(framingKindSchema.options.length),
});
export const framingPreferenceSchema = framingGroupSchema.extend({
	projectId: framingProjectId,
	id: z.uuid(),
	reverted: z.boolean(),
});
export const framingPreferencesSchema = z.array(framingPreferenceSchema);
export const revertFramingPreferenceSchema = z.strictObject({ id: z.uuid() });
export type FramingGroup = z.infer<typeof framingGroupSchema>;
export type FramingPreference = z.infer<typeof framingPreferenceSchema>;

/** Zoom evidence is measured in magnification. Card evidence is relative to frame height. */
export function framingKind({
	property,
	before,
	after,
}: {
	property: "zoom" | "card";
	before: number;
	after: number;
}): FramingGroup["kind"] | undefined {
	if (property === "zoom" && after >= 1 && after <= 4) {
		if (after / before >= 1.15) return "zoom-closer";
		if (after / before <= 0.85) return "zoom-wider";
	}
	if (property === "card" && Math.abs(after - before) >= 0.15) {
		if (after >= -0.5 && after <= -0.12) return "card-top";
		if (after <= 0.5 && after >= 0.12) return "card-bottom";
	}
}
