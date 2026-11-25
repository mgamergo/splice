import { useEffect, useMemo, useState } from "react";
import type { ClipWordCache } from "@/agent/captions";
import { useCaptionsStore } from "@/captions/store";
import { projectFormat } from "@/project/format";
import type { TProject } from "@/project/types";
import type { TSequence } from "@/timeline/types";
import { deriveTranscript } from "./sequence-transcript";
import type { CutTranscript } from "./transcript";

const EMPTY: CutTranscript = { paragraphs: [], sentences: [] };

/** Rebuilds the active cut transcript during idle time while the tab is open. */
export function useCutTranscript({
	project,
	sequence,
}: {
	project: TProject | null;
	sequence: TSequence | null;
}) {
	const [wordCache] = useState<ClipWordCache>(() => new Map());
	const isHorizontal = project && projectFormat({ project }) === "horizontal";
	const projectCaptions = isHorizontal ? project.captions : undefined;
	const shortSources =
		project && !isHorizontal ? sequence?.captions?.sources : undefined;
	const spellings = useCaptionsStore((state) =>
		isHorizontal ? state.spellings : undefined,
	);
	const tracks = sequence?.tracks;
	const markers = sequence?.markers;
	const inputs = useMemo(
		() => ({
			sequenceId: sequence?.id,
			tracks,
			markers,
			captions:
				projectCaptions ??
				(shortSources && {
					sources: shortSources,
					cueEdits: [],
					replacements: [],
				}),
			spellings,
		}),
		[sequence?.id, tracks, markers, projectCaptions, shortSources, spellings],
	);
	const [derived, setDerived] = useState<{
		inputs: typeof inputs;
		transcript: CutTranscript;
	}>();

	useEffect(() => {
		const { sequenceId, tracks, markers, captions, spellings } = inputs;
		if (
			sequenceId === undefined ||
			!tracks ||
			!markers ||
			!captions?.sources.length
		)
			return;
		const rebuild = () =>
			setDerived({
				inputs,
				transcript: deriveTranscript({
					sequence: { id: sequenceId, tracks, markers },
					captions,
					spellings,
					wordCache,
				}),
			});
		if (typeof window.requestIdleCallback === "function") {
			const id = window.requestIdleCallback(rebuild, { timeout: 500 });
			return () => window.cancelIdleCallback(id);
		}
		const id = window.setTimeout(rebuild, 0);
		return () => window.clearTimeout(id);
	}, [inputs, wordCache]);

	const transcript =
		derived && derived.inputs.sequenceId === inputs.sequenceId
			? derived.transcript
			: EMPTY;
	return { ...transcript, isUpdating: derived?.inputs !== inputs };
}
