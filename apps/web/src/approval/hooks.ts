import { useCallback, useEffect, useMemo, useState } from "react";
import { useCaptionsStore } from "@/captions/store";
import { useEditor } from "@/editor/use-editor";
import { readBridgeToken } from "@/bridge/token";
import { type ListedExport, listExports } from "@/export/deliver";
import { type ReviewState, reviewState } from "./review";

/** The active sequence's approval state, recomputed as the edit changes. */
export function useReviewState(): ReviewState | null {
	const editor = useEditor();
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const projectItems = useEditor((e) => e.media.getProjectItems());
	const spellings = useCaptionsStore((state) => state.spellings);
	return useMemo(
		() =>
			sequence && project && projectItems
				? reviewState({ editor, sequence, spellings })
				: null,
		[editor, sequence, project, projectItems, spellings],
	);
}

/**
 * This project's exports, newest first, from `splice`. Without `splice`
 * there are none to list.
 */
export function useProjectExports(): {
	exports: ListedExport[] | null;
	error: string | null;
} {
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id);
	const [exports, setExports] = useState<ListedExport[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const result = useEditor((e) => e.project.getExportState().result);
	useEffect(() => {
		let active = true;
		if (!projectId || !readBridgeToken()) {
			setExports([]);
			return;
		}
		void listExports({ projectId }).then(
			(result) => {
				if (!active) return;
				setExports(result.exports);
				setError(null);
			},
			(failure: unknown) => {
				if (active)
					setError(
						failure instanceof Error ? failure.message : String(failure),
					);
			},
		);
		return () => {
			active = false;
		};
	}, [projectId, result]);
	return { exports, error };
}

/** Load the spellings before the creator can approve a Horizontal export. */
export function useApprovalSpellings({
	enabled = true,
}: { enabled?: boolean } = {}) {
	const ready = useCaptionsStore((state) => state.spellingsLoaded);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(() => {
		setError(null);
		void useCaptionsStore
			.getState()
			.loadSpellings()
			.catch((failure: unknown) =>
				setError(failure instanceof Error ? failure.message : String(failure)),
			);
	}, []);
	useEffect(() => {
		if (enabled && !ready) load();
	}, [enabled, ready, load]);
	return { ready, error, retry: load };
}
