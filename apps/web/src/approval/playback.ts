import { create } from "zustand";
import { playCue } from "@/captions/project-captions";
import { AddPreparedSequenceCommand } from "@/commands/sequence/add-prepared-sequence";
import { RestoreCheckpointCommand } from "@/commands/sequence/restore-checkpoint";
import type { EditorCore } from "@/core";
import type { TSequence } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import type { ApprovedCheckpoint } from "./types";

/** Played around a passage, so the edit is heard in context. */
const CONTEXT_SECONDS = 1.5;

interface ApprovalViewState {
	/** Set while the creator watches an approved cut opened for comparison. */
	comparing: {
		checkpointId: string;
		copySequenceId: string;
		returnToSequenceId: string;
	} | null;
	setComparing: (comparing: ApprovalViewState["comparing"]) => void;
}

export const useApprovalViewStore = create<ApprovalViewState>((set) => ({
	comparing: null,
	setComparing: (comparing) => set({ comparing }),
}));

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
	playCue({
		editor,
		cue: {
			start: Math.max(0, start - CONTEXT_SECONDS),
			end: Math.max(end, start) + CONTEXT_SECONDS,
		},
	});
}

export function approvedCutName(checkpoint: ApprovedCheckpoint): string {
	return `Approved · ${checkpoint.sequenceName} · ${new Date(checkpoint.approvedAt).toLocaleString()}`;
}

/**
 * Opens the approved cut as a sequence of its own to watch, reusing one
 * opened before. Its edit is a copy; changing it changes no checkpoint.
 */
export function openApprovedCut({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): Promise<void> | void {
	const active = editor.sequences.getActiveSequence().id;
	const { comparing, setComparing } = useApprovalViewStore.getState();
	// From one approved cut to another, Back still returns to the edit.
	const returnToSequenceId =
		comparing?.copySequenceId === active
			? comparing.returnToSequenceId
			: active;
	const name = approvedCutName(checkpoint);
	const existing = editor.sequences
		.getSequences()
		.find((sequence) => sequence.name === name);
	const remember = (copySequenceId: string) =>
		setComparing({
			checkpointId: checkpoint.id,
			copySequenceId,
			returnToSequenceId,
		});
	if (existing) {
		remember(existing.id);
		if (existing.id !== active)
			return editor.sequences.switchToSequence({ sequenceId: existing.id });
		return;
	}
	const now = new Date();
	const sequence: TSequence = {
		id: generateUUID(),
		name,
		isMain: false,
		tracks: structuredClone(checkpoint.tracks),
		markers: structuredClone(checkpoint.markers),
		...(checkpoint.sequenceCaptions && {
			captions: structuredClone(checkpoint.sequenceCaptions),
		}),
		createdAt: now,
		updatedAt: now,
	};
	remember(sequence.id);
	editor.command.execute({
		command: new AddPreparedSequenceCommand({
			editor,
			sequence,
			label: "Open approved cut",
		}),
	});
}

/** Leaves the approved cut opened for comparison for the edit it was opened from. */
export async function backToCurrentEdit({
	editor,
}: {
	editor: EditorCore;
}): Promise<void> {
	const { comparing, setComparing } = useApprovalViewStore.getState();
	setComparing(null);
	if (
		comparing &&
		editor.sequences
			.getSequences()
			.some(({ id }) => id === comparing.returnToSequenceId)
	)
		await editor.sequences.switchToSequence({
			sequenceId: comparing.returnToSequenceId,
		});
}

/** Plays the approved version of a passage in the approved cut. */
export async function playApprovedPassage({
	editor,
	checkpoint,
	start,
	end,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
	start: number;
	end: number;
}): Promise<void> {
	await openApprovedCut({ editor, checkpoint });
	playPassage({ editor, start, end });
}

/** Returns the checkpoint's sequence to the approved edit, as one undoable edit. */
export function restoreCheckpoint({
	editor,
	checkpoint,
}: {
	editor: EditorCore;
	checkpoint: ApprovedCheckpoint;
}): boolean {
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
