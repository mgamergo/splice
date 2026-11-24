/**
 * Horizontal delivery: SRT captions and their corrections, and the MP4/SRT
 * pairs `splice` writes under Exports.
 */
import { z } from "zod";
import { captionSourceSchema, expectedRevision } from "./ops";

/** One transcript word: its recording and its position in that transcript. */
export const captionWordRefSchema = z.strictObject({
	projectItemId: z.string().min(1),
	index: z.number().int().nonnegative(),
});

/** The creator's text for the words one cue showed. Empty text hides them. */
export const cueEditSchema = z.strictObject({
	words: z.array(captionWordRefSchema).min(1).max(500),
	text: z.string().max(1000),
});

/** A wording fix applied wherever the words appear. */
export const replacementSchema = z.strictObject({
	from: z.string().trim().min(1).max(200),
	to: z.string().trim().min(1).max(200),
});

/** A Horizontal project's SRT captions: the words and the creator's corrections. */
export const projectCaptionsSchema = z.strictObject({
	sources: z.array(captionSourceSchema),
	cueEdits: z.array(cueEditSchema).default([]),
	/** Corrections the creator applied across the project. */
	replacements: z.array(replacementSchema).default([]),
});

export const CAPTION_SCOPES = ["cue", "project", "spelling"] as const;
export type CaptionScope = (typeof CAPTION_SCOPES)[number];

export const captionCuesRequestSchema = z.strictObject({
	sequenceId: z
		.string()
		.min(1)
		.optional()
		.describe("Sequence whose captions to list. Defaults to the active one."),
});

export const correctCaptionRequestSchema = z.strictObject({
	sequenceId: captionCuesRequestSchema.shape.sequenceId,
	expectedRevision,
	cueId: z.string().min(1).describe("The cue's id from captions_list"),
	text: z
		.string()
		.max(1000)
		.describe(
			"The cue's corrected text. With scope cue, empty text hides the cue.",
		),
	scope: z
		.enum(CAPTION_SCOPES)
		.default("cue")
		.describe(
			'"cue" fixes this cue only. "project" applies the changed words everywhere in this project. "spelling" also saves them as a reusable spelling for future projects.',
		),
});

/** One cue as the caption list and `captions_list` show it. Seconds on the sequence. */
export interface CaptionCueSummary {
	id: string;
	index: number;
	start: number;
	end: number;
	text: string;
	/** What the transcript said, when a correction changed it. */
	originalText?: string;
	/** The correction that shaped this cue, if any. */
	correctedBy?: CaptionScope;
}

/** Saved under Profile, applied to every project's captions. */
export const spellingsFileSchema = z.strictObject({
	version: z.literal(1),
	spellings: z.array(replacementSchema),
});

export const spellingRequestSchema = replacementSchema;
export const removeSpellingRequestSchema = z.strictObject({
	from: z.string().min(1).max(200),
});

export type CaptionWordRef = z.infer<typeof captionWordRefSchema>;
export type CueEdit = z.infer<typeof cueEditSchema>;
export type Replacement = z.infer<typeof replacementSchema>;
export type ProjectCaptions = z.infer<typeof projectCaptionsSchema>;
export type CorrectCaptionRequest = z.infer<typeof correctCaptionRequestSchema>;

/** What an export pair records about the edit it came from. */
export const exportSourceSchema = z.strictObject({
	projectId: z.string().min(1).max(200),
	projectName: z.string().min(1).max(200),
	sequenceId: z.string().min(1).max(200),
	sequenceName: z.string().max(200),
	/** The editor's command revision when the export started. */
	revision: z.number().int().nonnegative(),
	/** A hash of the exported sequence and its captions, stable across reloads. */
	fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/),
	durationSeconds: z.number().nonnegative(),
	cueCount: z.number().int().nonnegative(),
});

/** One published MP4/SRT pair under Exports. */
export const exportRecordSchema = exportSourceSchema.extend({
	/** Both files are `<stem>.mp4` and `<stem>.srt` in the Exports folder. */
	stem: z.string().min(1),
	exportedAt: z.string(),
	bytes: z.strictObject({ mp4: z.number(), srt: z.number() }),
});

export const exportsFileSchema = z.strictObject({
	version: z.literal(1),
	exports: z.array(exportRecordSchema),
});

export const EXPORT_FILE_KINDS = ["mp4", "srt"] as const;
export type ExportFileKind = (typeof EXPORT_FILE_KINDS)[number];

export const beginExportRequestSchema = exportSourceSchema;
export const exportIdRequestSchema = z.strictObject({
	exportId: z.string().regex(/^[0-9a-f-]{36}$/),
});
export const exportsListRequestSchema = z.strictObject({
	projectId: z
		.string()
		.min(1)
		.optional()
		.describe("Only this project's exports. Defaults to every project."),
});

export type ExportSource = z.infer<typeof exportSourceSchema>;
export type ExportRecord = z.infer<typeof exportRecordSchema>;

/**
 * Methods the editor tab calls on `splice` over `BRIDGE_PATHS.api`. Export
 * files go up separately, as `PUT <api>/exports/<exportId>/<mp4|srt>`.
 */
export const TAB_API_METHODS = [
	"transcript.words",
	"spellings.list",
	"spellings.save",
	"spellings.remove",
	"exports.list",
	"exports.begin",
	"exports.publish",
	"exports.abort",
	"exports.open",
] as const;
export type TabApiMethod = (typeof TAB_API_METHODS)[number];

export function isTabApiMethod(method: string): method is TabApiMethod {
	return (TAB_API_METHODS as readonly string[]).includes(method);
}
