import { z } from "zod";
import { isFootagePath, type ItemSummary } from "./index";

export const relinkItemInput = {
	projectItemId: z.string().min(1),
	path: z
		.string()
		.refine(isFootagePath, "Use a relative path from footage_list"),
	replace: z
		.boolean()
		.optional()
		.describe("Explicitly accept changed or unverifiable content"),
	expectedVersion: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Candidate version returned by the preview. Required with replace: true.",
		),
};

export const relinkItemSchema = z
	.strictObject(relinkItemInput)
	.refine(
		({ replace, expectedVersion }) => !replace || Boolean(expectedVersion),
		{
			path: ["expectedVersion"],
			message:
				"Pass expectedVersion from the relink preview when replacing a recording.",
		},
	);
export type RelinkItemRequest = z.infer<typeof relinkItemSchema>;

export type ItemVerification =
	| "match"
	| "changed"
	| "unverified"
	| "missing"
	| "backfilled";

export type RelinkItemResult =
	| {
			kind: "confirmation-required";
			verification: "changed" | "unverified";
			version: string;
	  }
	| {
			kind: "relinked";
			verification: "match" | "changed" | "unverified";
			item: ItemSummary;
	  };
