import { getPersistedKeybindingsState } from "../persisted-state";

export function v2ToV3({ state }: { state: unknown }): unknown {
	const v2 = getPersistedKeybindingsState({ state });
	if (!v2) return state;

	const renames: Record<string, string> = {
		"split-selected": "razor",
		"split-selected-left": "razor-left",
		"split-selected-right": "razor-right",
	};

	const migrated = { ...v2.keybindings };
	for (const [key, action] of Object.entries(migrated)) {
		const renamedAction = action ? renames[action] : undefined;
		if (renamedAction) {
			migrated[key] = renamedAction;
		}
	}

	return { ...v2, keybindings: migrated };
}
