import { z } from "zod";

export const STORAGE_CATEGORIES = [
	"pauses",
	"loudness",
	"noise-reduction",
	"temporary-renders",
	"export-staging",
] as const;

export type StorageCategory = (typeof STORAGE_CATEGORIES)[number];

export const storageSelectionSchema = z.object({
	categories: z.array(z.enum(STORAGE_CATEGORIES)).optional(),
	olderThanDays: z.number().finite().nonnegative().max(365_000).optional(),
});

export const storageCleanupSchema = storageSelectionSchema.extend({
	dryRun: z.boolean().default(true),
});

export const storageReportSchema = z.object({
	dryRun: z.boolean(),
	reclaimableBytes: z.number(),
	freedBytes: z.number(),
	categories: z.array(
		z.object({
			category: z.enum(STORAGE_CATEGORIES),
			bytes: z.number(),
			items: z.number(),
			freedBytes: z.number(),
		}),
	),
	kept: z.array(
		z.object({
			category: z.string(),
			reason: z.string(),
			bytes: z.number(),
			items: z.number(),
		}),
	),
	errors: z.array(z.object({ path: z.string(), message: z.string() })),
});

export type StorageReport = z.infer<typeof storageReportSchema>;
