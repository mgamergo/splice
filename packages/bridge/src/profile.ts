import { z } from "zod";
import { takeSchema } from "./ops";

const rangeSchema = z
	.strictObject({
		projectItemId: z.string().min(1),
		recording: z
			.string()
			.min(1)
			.describe("Footage path or the recording's name"),
		sourceIn: z.number().nonnegative(),
		sourceOut: z.number().positive(),
	})
	.refine(({ sourceIn, sourceOut }) => sourceOut > sourceIn);

const takeDecisionSchema = z.strictObject({
	markerId: z.string().min(1),
	sectionName: z.string().min(1),
	agentBestTake: takeSchema,
	agentBestRanges: z.array(rangeSchema).min(1),
	selectedTakes: z.array(takeSchema).min(1),
});

export const tighteningKindSchema = z.enum([
	"pause",
	"false_start",
	"filler_word",
]);
export type TighteningKind = z.infer<typeof tighteningKindSchema>;
const tighteningEdgeSchema = z
	.strictObject({
		kind: tighteningKindSchema,
		sourceIn: z.number().nonnegative(),
		sourceOut: z.number().positive(),
		removedSeconds: z.number().positive(),
		pauseSeconds: z.number().positive().optional(),
	})
	.refine(({ sourceIn, sourceOut }) => sourceOut > sourceIn);
export type TighteningEdge = z.infer<typeof tighteningEdgeSchema>;

const correctionFields = {
	before: z.array(rangeSchema),
	after: z.array(rangeSchema).min(1),
};

const takeCorrectionSchema = z.strictObject({
	...correctionFields,
	kind: z.enum(["swap_take", "restore_takes"]),
	decision: takeDecisionSchema,
});

const trimCorrectionSchema = z.strictObject({
	...correctionFields,
	kind: z.literal("retrim"),
	decision: tighteningEdgeSchema.safeExtend({
		edge: z.enum(["in", "out"]),
	}),
});

export type CorrectionEdit =
	| z.infer<typeof takeCorrectionSchema>
	| z.infer<typeof trimCorrectionSchema>;

const context = {
	id: z.uuid(),
	projectId: z.string().min(1),
	sequenceId: z.string().min(1),
	revision: z.number().int().nonnegative(),
	timestamp: z.iso.datetime(),
};

export const correctionSchema = z.discriminatedUnion("kind", [
	takeCorrectionSchema.extend(context),
	trimCorrectionSchema.extend(context),
]);
export type Correction = z.infer<typeof correctionSchema>;

export const correctionStatusEventSchema = z.strictObject({
	...context,
	kind: z.enum(["cancel", "reactivate"]),
	correctionId: z.uuid(),
});
export type CorrectionStatusEvent = z.infer<typeof correctionStatusEventSchema>;
export const correctionEventSchema = z.union([
	correctionSchema,
	correctionStatusEventSchema,
]);
export type CorrectionEvent = z.infer<typeof correctionEventSchema>;

export const profileCaptureSchema = z.union([
	z.strictObject({ events: z.array(correctionEventSchema).min(1).max(100) }),
	// Older editor tabs still send just the initial Corrections.
	z.strictObject({ corrections: z.array(correctionSchema).min(1).max(100) }),
]);

export const profilePendingSchema = z.strictObject({
	after: z.uuid().optional().describe("nextCursor from the previous page"),
	limit: z.number().int().min(1).max(100).default(25),
});

export const profileApplySchema = z.strictObject({
	text: z
		.string()
		.max(64_000)
		.refine((text) => text.trim().length > 0)
		.describe("The full updated profile.md Markdown"),
	correctionIds: z
		.array(z.uuid())
		.min(1)
		.max(1_000)
		.describe("IDs of the pending Corrections reflected in this update"),
	expectedVersion: z
		.string()
		.min(1)
		.describe("The version returned by profile_read"),
	operationId: z
		.uuid()
		.describe(
			"A new UUID for this update. Reuse it with identical arguments when retrying.",
		),
});

export const profileQuestionSchema = z.strictObject({
	id: z.uuid(),
	text: z.string().trim().min(1).max(500),
});

export const profileQuestionResponseSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("dismiss"), id: z.uuid() }),
	z.strictObject({
		kind: z.literal("answer"),
		id: z.uuid(),
		answer: z.string().trim().min(1).max(2_000),
	}),
]);

export const profileUpdateSummarySchema = z.strictObject({
	id: z.uuid(),
	timestamp: z.iso.datetime(),
	correctionCount: z.number().int().nonnegative(),
	answerCount: z.number().int().nonnegative(),
	reverts: z.uuid().optional(),
	canRevert: z.boolean(),
});

export const profilePanelSchema = z.strictObject({
	text: z.string(),
	updates: z.array(profileUpdateSummarySchema),
});

export const profileProviderSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("off") }),
	z.strictObject({
		kind: z.literal("api"),
		baseUrl: z
			.url({ protocol: /^https?$/ })
			.max(500)
			.refine((value) => {
				if (!URL.canParse(value)) return false;
				const url = new URL(value);
				return (
					!url.username &&
					!url.password &&
					!url.search &&
					!url.hash &&
					(url.protocol === "https:" ||
						["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
				);
			}),
		model: z.string().trim().min(1).max(200),
	}),
	z.strictObject({
		kind: z.literal("cli"),
		command: z.enum(["codex", "claude"]),
		allowNonInteractive: z.literal(true),
	}),
]);
export type ProfileProviderSettings = z.infer<typeof profileProviderSchema>;

export const profileSettingsSchema = z.strictObject({
	provider: profileProviderSchema,
	hasApiKey: z.boolean(),
});
