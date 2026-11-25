import type { ItemSummary } from "@splice/bridge";
import type {
	CaptionScope,
	ProjectCaptions,
	Replacement,
} from "@splice/bridge/delivery";
import type { CaptionsRequest } from "@splice/bridge/ops";
import { z } from "zod";
import { callSplice } from "@/bridge/splice-api";
import { UpdateProjectCaptionsCommand } from "@/commands/project/update-project-captions";
import type { EditorCore } from "@/core";
import { summarizeItem } from "@/media/import-disk";
import { calculateTotalDuration } from "@/timeline";
import type { TSequence } from "@/timeline/types";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import {
	buildCaptionCues,
	type CaptionCue,
	planCorrection,
	withoutRuleFor,
} from "./cues";
import { useCaptionsStore } from "./store";

const EMPTY_CAPTIONS: ProjectCaptions = {
	sources: [],
	cueEdits: [],
	replacements: [],
};

export function sequenceEndSeconds({ sequence }: { sequence: TSequence }) {
	return mediaTimeToSeconds({
		time: calculateTotalDuration({ tracks: sequence.tracks }),
	});
}

/** The SRT cues of a sequence with the project's corrections and the saved spellings. */
export function sequenceCaptionCues({
	editor,
	sequence,
	spellings = useCaptionsStore.getState().spellings,
}: {
	editor: EditorCore;
	sequence: TSequence;
	spellings?: Replacement[];
}): CaptionCue[] {
	return buildCaptionCues({
		tracks: sequence.tracks,
		captions: editor.project.getActiveOrNull()?.captions,
		spellings,
		sequenceEnd: sequenceEndSeconds({ sequence }),
		sequenceId: sequence.id,
	});
}

/** Sets the transcript words captions come from, keeping every correction. */
export function setCaptionSources({
	editor,
	sources,
	label = "Load caption words",
}: {
	editor: EditorCore;
	sources: CaptionsRequest["sources"];
	label?: string;
}): void {
	const current = editor.project.getActive().captions ?? EMPTY_CAPTIONS;
	editor.command.execute({
		command: new UpdateProjectCaptionsCommand({
			editor,
			captions: { ...current, sources },
			label,
		}),
	});
}

const transcriptWordsSchema = z.object({
	transcripts: z.array(
		z.object({
			path: z.string(),
			words: z.array(
				z.object({ start: z.number(), end: z.number(), text: z.string() }),
			),
		}),
	),
});

/** Recordings in the project that reference Footage, so `splice` may hold their transcripts. */
function recordings({ editor }: { editor: EditorCore }): ItemSummary[] {
	return editor.media
		.getProjectItems()
		.map(summarizeItem)
		.filter(
			(item): item is ItemSummary & { path: string } =>
				item.path !== null &&
				!item.missing &&
				(item.type === "video" || item.type === "audio"),
		);
}

/**
 * Loads the cached transcripts of the project's recordings from `splice` as
 * caption words. Returns the recordings that have no transcript yet.
 */
export async function loadCaptionWords({
	editor,
}: {
	editor: EditorCore;
}): Promise<{ loaded: number; withoutTranscript: string[] }> {
	const items = recordings({ editor });
	const paths = [...new Set(items.flatMap(({ path }) => (path ? [path] : [])))];
	const wordsByPath = new Map<string, CaptionsRequest["sources"][number]["words"]>();
	// transcript.words takes at most 200 paths per call.
	for (let offset = 0; offset < paths.length; offset += 200) {
		const { transcripts } = transcriptWordsSchema.parse(
			await callSplice({
				method: "transcript.words",
				params: { paths: paths.slice(offset, offset + 200) },
			}),
		);
		for (const { path, words } of transcripts) wordsByPath.set(path, words);
	}
	const sources = items.flatMap(({ id, path }) => {
		const words = path ? wordsByPath.get(path) : undefined;
		return words?.length ? [{ projectItemId: id, words }] : [];
	});
	const withoutTranscript = items
		.filter(({ path }) => !path || !wordsByPath.get(path)?.length)
		.map(({ name }) => name);
	if (sources.length) setCaptionSources({ editor, sources });
	return { loaded: sources.length, withoutTranscript };
}

/**
 * Applies a correction to one cue, across the project, or as a reusable
 * spelling `splice` keeps for every project. Returns the words a project or
 * spelling correction replaces.
 */
export async function correctCaption({
	editor,
	sequenceId,
	cue,
	text,
	scope,
}: {
	editor: EditorCore;
	/** The sequence the cue is on. */
	sequenceId: string;
	cue: CaptionCue;
	text: string;
	scope: CaptionScope;
}): Promise<{ replacement?: Replacement }> {
	const captions = editor.project.getActive().captions ?? EMPTY_CAPTIONS;
	const plan = planCorrection({ cue, text, scope, captions, sequenceId });
	if (plan.scope === "spelling") {
		await useCaptionsStore.getState().saveSpelling(plan.replacement);
		// The project's own correction of these words would hide the spelling.
		const withoutRule = withoutRuleFor({
			captions: editor.project.getActive().captions ?? EMPTY_CAPTIONS,
			spelling: plan.replacement,
		});
		if (withoutRule)
			editor.command.execute({
				command: new UpdateProjectCaptionsCommand({
					editor,
					captions: withoutRule,
					label: "Use the saved spelling",
				}),
			});
		return { replacement: plan.replacement };
	}
	editor.command.execute({
		command: new UpdateProjectCaptionsCommand({
			editor,
			captions: plan.captions,
			label:
				plan.scope === "cue" ? "Correct caption" : "Correct captions in project",
		}),
	});
	return plan.scope === "project" ? { replacement: plan.replacement } : {};
}

const passageStops = new WeakMap<EditorCore["playback"], () => void>();

/**
 * Plays one cue's passage and pauses with the playhead on its end, unless the
 * creator pauses or seeks first.
 */
export function playCue({
	editor,
	cue,
}: {
	editor: Pick<EditorCore, "playback">;
	cue: Pick<CaptionCue, "start" | "end">;
}): void {
	const { playback } = editor;
	passageStops.get(playback)?.();
	const end = mediaTimeFromSeconds({ seconds: cue.end });
	playback.seek({ time: mediaTimeFromSeconds({ seconds: cue.start }) });
	playback.play();
	const finish = () => {
		stop();
		playback.pause();
		playback.seek({ time: end });
	};
	// Frames can come slowly, so a timer ends the passage on time too.
	const timer = setTimeout(finish, (cue.end - cue.start) * 1000);
	const unsubscribeUpdate = playback.onUpdate((time) => {
		if (time >= end) finish();
	});
	const unsubscribeSeek = playback.onSeek(() => stop());
	const unsubscribePause = playback.subscribe(() => {
		if (!playback.getIsPlaying()) stop();
	});
	function stop() {
		clearTimeout(timer);
		unsubscribeUpdate();
		unsubscribeSeek();
		unsubscribePause();
		passageStops.delete(playback);
	}
	passageStops.set(playback, stop);
}
