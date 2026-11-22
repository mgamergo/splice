import { z } from "zod";

const webEnvSchema = z.object({
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Optional: enables the sound library search.
	FREESOUND_CLIENT_ID: z.string().optional(),
	FREESOUND_API_KEY: z.string().optional(),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
