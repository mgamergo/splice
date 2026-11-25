import { create } from "zustand";

/** The sentences the creator picked: one, or a range from anchor to focus. */
export interface TranscriptSelection {
	sequenceId: string;
	anchorId: string;
	focusId: string;
}

interface TranscriptState {
	selection: TranscriptSelection | null;
	/** Selects one sentence, or extends the selection to it on the same sequence. */
	select: (options: {
		sequenceId: string;
		sentenceId: string;
		extend?: boolean;
	}) => void;
	clear: () => void;
}

export const useTranscriptStore = create<TranscriptState>((set, get) => ({
	selection: null,
	select: ({ sequenceId, sentenceId, extend = false }) => {
		const current = get().selection;
		set({
			selection:
				extend && current?.sequenceId === sequenceId
					? { ...current, focusId: sentenceId }
					: { sequenceId, anchorId: sentenceId, focusId: sentenceId },
		});
	},
	clear: () => set({ selection: null }),
}));
