import type { ProjectCaptions, Replacement } from "@splice/bridge/delivery";
import { buildCaptionCues } from "@/captions/cues";
import { sequenceEndSeconds } from "@/captions/project-captions";
import { projectFormat } from "@/project/format";
import type { TProject } from "@/project/types";
import type { TSequence } from "@/timeline/types";
import { buildCutTranscript, type CutTranscript } from "./transcript";

/**
 * The words a sequence's transcript reads: a Horizontal project's caption
 * words with their corrections, or the words a Short's burned-in captions
 * were built from.
 */
function transcriptCaptions({
	project,
	sequence,
}: {
	project: TProject;
	sequence: TSequence;
}): ProjectCaptions | undefined {
	if (projectFormat({ project }) === "horizontal") return project.captions;
	return sequence.captions
		? { sources: sequence.captions.sources, cueEdits: [], replacements: [] }
		: undefined;
}

export function hasTranscriptWords({
	project,
	sequence,
}: {
	project: TProject;
	sequence: TSequence;
}): boolean {
	return !!transcriptCaptions({ project, sequence })?.sources.length;
}

/** The cut transcript of a sequence, read through the same corrections as its captions. */
export function sequenceTranscript({
	project,
	sequence,
	spellings = [],
}: {
	project: TProject;
	sequence: TSequence;
	/** Horizontal projects only; Shorts burn in their captions uncorrected. */
	spellings?: Replacement[];
}): CutTranscript {
	const isHorizontal = projectFormat({ project }) === "horizontal";
	const cues = buildCaptionCues({
		tracks: sequence.tracks,
		captions: transcriptCaptions({ project, sequence }),
		spellings: isHorizontal ? spellings : [],
		sequenceEnd: sequenceEndSeconds({ sequence }),
	});
	return buildCutTranscript({
		cues,
		tracks: sequence.tracks,
		markers: sequence.markers,
	});
}
