import { create } from "zustand";
import { playCue } from "@/captions/project-captions";
import { RestoreCheckpointCommand } from "@/commands/sequence/restore-checkpoint";
import {
	requireApprovedMedia,
	verifySequenceMedia,
} from "@/media/sequence-media";
import type { EditorCore } from "@/core";
import type { ApprovedCheckpoint } from "./types";

/** Played around a passage, so the edit is heard in context. */
const CONTEXT_SECONDS = 1.5;

interface ApprovedPlayback {
	checkpoint: ApprovedCheckpoint;
	passage?: { start: number; end: number };
}

interface ApprovalViewState {
	preview: ApprovedPlayback | null;
	setPreview: (preview: ApprovedPlayback | null) => void;
}

export const useApprovalViewStore = create<ApprovalViewState>((set) => ({
	preview: null,
	setPreview: (preview) => set({ preview }),
}));

export function passageWithContext({
	start,
	end,
}: {
	start: number;
	end: number;
}) {
	return {
		start: Math.max(0, start - CONTEXT_SECONDS),
		end: Math.max(end, start) + CONTEXT_SECONDS,
	};
}

/** Plays a passage with a little before and after it, then stops. */
export function playPassage({
	editor,
	start,
	end,
}: {
	editor: EditorCore;
	start: number;
	end: number;
}): void {
	playCue({ editor, cue: passageWithContext({ start, end }) });
}

/** Watch the saved tracks without opening or editing another sequence. */
export function watchApprovedCut({
	editor,
	checkpoint,
	passage,
}: { editor: EditorCore } & ApprovedPlayback): void {
	if (editor.project.isExportRunning()) return;
	editor.playback.pause();
	useApprovalViewStore.getState().setPreview({ checkpoint, passage });
}

/** Returns the checkpoint's sequence to the approved edit, as one undoable edit. */
export async function restoreCheckpoint({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): Promise<boolean> {
	if (
		!editor.sequences
			.getSequences()
			.some(({ id }) => id === checkpoint.sequenceId)
	)
		return false;
	const generation = editor.media.getGeneration();
	const projectItems = editor.media.getProjectItems();
	await verifySequenceMedia({ tracks: checkpoint.tracks, projectItems });
	requireApprovedMedia({ footage: checkpoint.footage, projectItems });
	if (
		generation !== editor.media.getGeneration() ||
		projectItems !== editor.media.getProjectItems()
	)
		throw new Error("The project changed. Open Review and try again.");
	if (
		!editor.sequences
			.getSequences()
			.some(({ id }) => id === checkpoint.sequenceId)
	)
		return false;
	editor.command.execute({
		command: new RestoreCheckpointCommand({ editor, checkpoint }),
	});
	return true;
}
