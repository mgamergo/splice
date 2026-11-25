import { useCallback, useEffect, useMemo, useState } from "react";
import { useCaptionsStore } from "@/captions/store";
import { useEditor } from "@/editor/use-editor";
import { readBridgeToken } from "@/bridge/token";
import {
	deliveryFingerprint,
	type ListedExport,
	listExports,
	takeDeliverySnapshot,
} from "@/export/deliver";
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

/** The fingerprint an export of the current edit would record. */
export function useCurrentFingerprint(): string | null {
	const editor = useEditor();
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	const project = useEditor((e) => e.project.getActiveOrNull());
	const spellings = useCaptionsStore((state) => state.spellings);
	const [fingerprint, setFingerprint] = useState<string | null>(null);
	useEffect(() => {
		if (!sequence || !project) return;
		let cancelled = false;
		void deliveryFingerprint(takeDeliverySnapshot({ editor })).then((value) => {
			if (!cancelled) setFingerprint(value);
		});
		return () => {
			cancelled = true;
		};
	}, [editor, sequence, project, spellings]);
	return fingerprint;
}

/**
 * This project's exports, newest first, from `splice`. Without `splice`
 * there are none to list.
 */
export function useProjectExports(): {
	exports: ListedExport[] | null;
	error: string | null;
	refresh: () => Promise<void>;
} {
	const projectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id);
	const [exports, setExports] = useState<ListedExport[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refresh = useCallback(async () => {
		if (!projectId || !readBridgeToken()) {
			setExports([]);
			return;
		}
		try {
			setExports((await listExports({ projectId })).exports);
			setError(null);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, [projectId]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return { exports, error, refresh };
}
