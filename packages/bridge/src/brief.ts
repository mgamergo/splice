import { z } from "zod";
import { expectedRevision } from "./revision";

export const projectBriefSchema = z.strictObject({
	text: z.string().trim().max(8000).default(""),
	audience: z.string().trim().min(1).max(500).optional(),
	goal: z.string().trim().min(1).max(500).optional(),
	targetDurationSeconds: z.number().positive().optional(),
	mustKeepPoints: z
		.array(
			z
				.string()
				.trim()
				.min(1)
				.max(500)
				.regex(/^[^\r\n]*$/, "Use one line per must-keep point."),
		)
		.max(30)
		.optional(),
	tone: z.string().trim().min(1).max(500).optional(),
});

export type ProjectBrief = z.output<typeof projectBriefSchema>;

export const briefSetRequestSchema = z.strictObject({
	projectId: z.string().min(1),
	expectedRevision,
	brief: projectBriefSchema
		.nullable()
		.describe("The complete project brief. Pass null to clear it."),
});

export function normalizeProjectBrief(brief: ProjectBrief | null | undefined) {
	if (!brief) return undefined;
	const { mustKeepPoints, ...fields } = brief;
	if (!mustKeepPoints?.length && !Object.values(fields).some(Boolean))
		return undefined;
	return { ...fields, ...(mustKeepPoints?.length && { mustKeepPoints }) };
}
