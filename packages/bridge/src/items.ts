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
		.optional()
		.describe("Candidate version returned by a preview, when available"),
};

export const relinkItemSchema = z.strictObject(relinkItemInput);
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
			version: string | undefined;
	  }
	| {
			kind: "relinked";
			verification: "match" | "changed" | "unverified";
			item: ItemSummary;
	  };
