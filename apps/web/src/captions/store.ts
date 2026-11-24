import {
	type Replacement,
	replacementSchema,
} from "@splice/bridge/delivery";
import { z } from "zod";
import { create } from "zustand";
import { callSplice } from "@/bridge/splice-api";
import { readBridgeToken } from "@/bridge/token";

const spellingsResultSchema = z.object({
	spellings: z.array(replacementSchema),
});

interface CaptionsState {
	/** Reusable spellings from `splice`, applied to every project's captions. */
	spellings: Replacement[];
	spellingsLoaded: boolean;
	/** The cue the caption list and the preview overlay have selected. */
	selectedCueId: string | null;
	selectCue: (cueId: string | null) => void;
	/** Fetches the spellings once; later calls reuse them. */
	loadSpellings: (options?: { force?: boolean }) => Promise<Replacement[]>;
	saveSpelling: (spelling: Replacement) => Promise<void>;
	removeSpelling: (from: string) => Promise<void>;
}

export const useCaptionsStore = create<CaptionsState>((set, get) => ({
	spellings: [],
	spellingsLoaded: false,
	selectedCueId: null,
	selectCue: (selectedCueId) => set({ selectedCueId }),
	loadSpellings: async ({ force = false } = {}) => {
		if (get().spellingsLoaded && !force) return get().spellings;
		// Outside splice there is nowhere to keep spellings.
		if (!readBridgeToken()) {
			set({ spellingsLoaded: true });
			return [];
		}
		const { spellings } = spellingsResultSchema.parse(
			await callSplice({ method: "spellings.list" }),
		);
		set({ spellings, spellingsLoaded: true });
		return spellings;
	},
	saveSpelling: async (spelling) => {
		const { spellings } = spellingsResultSchema.parse(
			await callSplice({ method: "spellings.save", params: spelling }),
		);
		set({ spellings, spellingsLoaded: true });
	},
	removeSpelling: async (from) => {
		const { spellings } = spellingsResultSchema.parse(
			await callSplice({ method: "spellings.remove", params: { from } }),
		);
		set({ spellings, spellingsLoaded: true });
	},
}));
