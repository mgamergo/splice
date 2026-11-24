import { useMemo } from "react";
import { useCaptionsStore } from "@/captions/store";
import { useEditor } from "@/editor/use-editor";
import { sequenceTranscript } from "./sequence-transcript";
import type { CutTranscript } from "./transcript";

const EMPTY: CutTranscript = { paragraphs: [], sentences: [] };

/** The active sequence's cut transcript, rebuilt whenever the sequence changes. */
export function useCutTranscript(): CutTranscript {
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const spellings = useCaptionsStore((state) => state.spellings);
	return useMemo(
		() =>
			sequence && project
				? sequenceTranscript({ project, sequence, spellings })
				: EMPTY,
		[sequence, project, spellings],
	);
}
