/**
 * The final mix: optional music fitted to the sequence and ducked under
 * speech, and one gain for the whole mix with a true-peak ceiling, applied
 * the same way in the final preview and in export.
 */
import { z } from "zod";
import { DEFAULT_TARGET_LUFS, expectedRevision, MAX_TRUE_PEAK_DBTP } from "./ops";

export const MUSIC_TRACK_NAME = "Music";
/** Music sits this far below the narration target in quiet passages. */
export const DEFAULT_MUSIC_QUIET_LU = -10;
/** And this much lower again under speech. */
export const DEFAULT_DUCK_DB = -14;
/** Clip gain when the music can't be measured, e.g. a silent file. */
export const DEFAULT_MUSIC_LEVEL_DB = -12;

const seconds = z.number().nonnegative();

/** A passage, in sequence seconds, where music stays ducked so application sounds come through. */
export const mixOverrideSchema = z
	.strictObject({
		start: seconds.describe("Sequence seconds"),
		end: z.number().positive().describe("Sequence seconds"),
		note: z.string().max(200).optional(),
	})
	.refine((range) => range.end > range.start, {
		path: ["end"],
		message: "End must be after start",
	});

const levelDb = z.number().min(-60).max(20);

/** How the music is fitted, faded and ducked. Saved with the sequence. */
export const musicSettingsSchema = z.strictObject({
	projectItemId: z.string().min(1),
	/** The audio track holding the fitted music. */
	trackId: z.string().min(1),
	/** Clip gain in dB while nobody speaks. */
	levelDb: levelDb.describe(
		"Music clip gain in dB in quiet passages. Defaults to a level 10 LU under the narration target, from a measurement of the track.",
	),
	duckDb: z
		.number()
		.min(-60)
		.max(0)
		.describe(
			`How far music dips under speech, in dB below levelDb (default ${DEFAULT_DUCK_DB})`,
		),
	fadeInSeconds: z.number().min(0).max(30),
	fadeOutSeconds: z.number().min(0).max(30),
	/** Pauses shorter than this stay ducked, so music doesn't pump between phrases. */
	holdPauseSeconds: z.number().min(0).max(10),
	overrides: z.array(mixOverrideSchema).max(500),
	/** The track's integrated loudness when it was added, or null if it couldn't be measured. */
	musicLufs: z.number().nullable(),
});

/** The whole-mix gain, from a measurement of everything the sequence plays. */
export const mixLoudnessSchema = z.strictObject({
	targetLufs: z.number().min(-40).max(-5),
	ceilingDbtp: z.number().min(-9).max(0),
	gainDb: z.number().min(-40).max(40),
	/** The mix before the gain. */
	measuredLufs: z.number().nullable(),
	measuredTruePeakDbtp: z.number().nullable(),
	/** The mix after the gain and the ceiling, as export writes it. */
	expectedLufs: z.number().nullable(),
	expectedTruePeakDbtp: z.number().nullable(),
	/** Identifies the audio measured, so a later edit shows the gain is stale. */
	fingerprint: z.string(),
});

export const sequenceMixSchema = z.strictObject({
	music: musicSettingsSchema.optional(),
	loudness: mixLoudnessSchema.optional(),
});

const sequenceId = z
	.string()
	.min(1)
	.optional()
	.describe("Sequence to mix. Defaults to the active sequence.");

const musicOptions = {
	levelDb: levelDb
		.optional()
		.describe(
			"Music clip gain in dB in quiet passages. Defaults to 10 LU under the narration target, from a measurement of the track.",
		),
	duckDb: musicSettingsSchema.shape.duckDb.optional(),
	fadeInSeconds: musicSettingsSchema.shape.fadeInSeconds
		.optional()
		.describe("Fade in at the start, in seconds (default 2)"),
	fadeOutSeconds: musicSettingsSchema.shape.fadeOutSeconds
		.optional()
		.describe("Fade out at the end, in seconds (default 3)"),
	holdPauseSeconds: musicSettingsSchema.shape.holdPauseSeconds
		.optional()
		.describe(
			"Pauses in speech shorter than this keep the music ducked (default 1.5). Longer quiet passages let it rise gently.",
		),
	overrides: musicSettingsSchema.shape.overrides
		.optional()
		.describe(
			"Passages in sequence seconds where music stays ducked even without speech, to keep application sounds audible. Replaces the saved list.",
		),
};

export const addMusicRequestSchema = z.strictObject({
	sequenceId,
	expectedRevision,
	projectItemId: z
		.string()
		.min(1)
		.describe("The audio project item to use, from items_list or items_import"),
	...musicOptions,
	label: z.string().min(1).max(120).optional(),
});

export const updateMusicRequestSchema = z.strictObject({
	sequenceId,
	expectedRevision,
	...musicOptions,
	label: z.string().min(1).max(120).optional(),
});

export const removeMusicRequestSchema = z.strictObject({
	sequenceId,
	expectedRevision,
	label: z.string().min(1).max(120).optional(),
});

export const mixLoudnessRequestSchema = z.strictObject({
	sequenceId,
	expectedRevision: expectedRevision
		.optional()
		.describe(
			"The revision measured against. Required to save the gain (apply true).",
		),
	targetLufs: z
		.number()
		.min(-40)
		.max(-5)
		.optional()
		.describe(`Integrated loudness target in LUFS (default ${DEFAULT_TARGET_LUFS})`),
	ceilingDbtp: z
		.number()
		.min(-9)
		.max(0)
		.optional()
		.describe(`True-peak ceiling in dBTP (default ${MAX_TRUE_PEAK_DBTP})`),
	apply: z
		.boolean()
		.default(true)
		.describe(
			"Save the gain on the sequence, as one undo step, so preview and export play the adjusted mix. false only measures.",
		),
	label: z.string().min(1).max(120).optional(),
});

export type MixOverride = z.infer<typeof mixOverrideSchema>;
export type MusicSettings = z.infer<typeof musicSettingsSchema>;
export type MixLoudness = z.infer<typeof mixLoudnessSchema>;
export type SequenceMix = z.infer<typeof sequenceMixSchema>;
export type AddMusicRequest = z.infer<typeof addMusicRequestSchema>;
export type UpdateMusicRequest = z.infer<typeof updateMusicRequestSchema>;
