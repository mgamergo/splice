import { useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { projectFormat } from "@/project/format";
import { buildCaptionCues, type CaptionCue } from "./cues";
import { sequenceEndSeconds } from "./project-captions";
import { useCaptionsStore } from "./store";

/** The active sequence's SRT cues; empty outside Horizontal projects. */
export function useCaptionCues(): CaptionCue[] {
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const spellings = useCaptionsStore((state) => state.spellings);
	const isHorizontal = !!project && projectFormat({ project }) === "horizontal";
	const captions = project?.captions;
	return useMemo(
		() =>
			sequence && isHorizontal
				? buildCaptionCues({
						tracks: sequence.tracks,
						captions,
						spellings,
						sequenceEnd: sequenceEndSeconds({ sequence }),
						sequenceId: sequence.id,
					})
				: [],
		[sequence, isHorizontal, captions, spellings],
	);
}
