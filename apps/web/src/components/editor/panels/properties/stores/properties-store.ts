import { create } from "zustand";

interface PropertiesState {
	activeTabPerType: Record<string, string>;
	setActiveTab: (args: { clipType: string; tabId: string }) => void;
	isTransformScaleLocked: boolean;
	setTransformScaleLocked: (args: { locked: boolean }) => void;
}

export const usePropertiesStore = create<PropertiesState>()((set) => ({
	activeTabPerType: {},
	setActiveTab: ({ clipType, tabId }) =>
		set((state) => ({
			activeTabPerType: { ...state.activeTabPerType, [clipType]: tabId },
		})),
	isTransformScaleLocked: false,
	setTransformScaleLocked: ({ locked }) =>
		set({ isTransformScaleLocked: locked }),
}));
