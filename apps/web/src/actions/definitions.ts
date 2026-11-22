import type { ShortcutKey } from "@/actions/keybinding";
import type { TActionWithArgs, TActionWithOptionalArgs } from "./types";

export type TActionCategory =
	| "playback"
	| "navigation"
	| "editing"
	| "selection"
	| "history"
	| "timeline"
	| "controls"
	| "projectItems";

export interface TActionBaseDefinition {
	description: string;
	category: TActionCategory;
	args?: Record<string, unknown>;
}

export interface TActionDefinition extends TActionBaseDefinition {
	defaultShortcuts?: readonly ShortcutKey[];
}

export const ACTIONS = {
	"toggle-play": {
		description: "Play/Pause",
		category: "playback",
	},
	"stop-playback": {
		description: "Stop playback",
		category: "playback",
	},
	"seek-forward": {
		description: "Seek forward 1 second",
		category: "playback",
		args: { seconds: "number" },
	},
	"seek-backward": {
		description: "Seek backward 1 second",
		category: "playback",
		args: { seconds: "number" },
	},
	"frame-step-forward": {
		description: "Frame step forward",
		category: "navigation",
	},
	"frame-step-backward": {
		description: "Frame step backward",
		category: "navigation",
	},
	"jump-forward": {
		description: "Jump forward 5 seconds",
		category: "navigation",
		args: { seconds: "number" },
	},
	"jump-backward": {
		description: "Jump backward 5 seconds",
		category: "navigation",
		args: { seconds: "number" },
	},
	"goto-start": {
		description: "Go to timeline start",
		category: "navigation",
	},
	"goto-end": {
		description: "Go to timeline end",
		category: "navigation",
	},
	razor: {
		description: "Razor clips at playhead",
		category: "editing",
	},
	"razor-left": {
		description: "Razor and remove left",
		category: "editing",
	},
	"razor-right": {
		description: "Razor and remove right",
		category: "editing",
	},
	"delete-selected": {
		description: "Delete current selection",
		category: "editing",
	},
	"copy-selected": {
		description: "Copy selected clips",
		category: "editing",
	},
	"paste-copied": {
		description: "Paste clips at playhead",
		category: "editing",
	},
	"toggle-snapping": {
		description: "Toggle snapping",
		category: "editing",
	},
	"toggle-ripple-editing": {
		description: "Toggle ripple editing",
		category: "editing",
	},
	"toggle-source-audio": {
		description: "Extract or recover source audio",
		category: "editing",
	},
	"select-all": {
		description: "Select all clips",
		category: "selection",
	},
	"cancel-interaction": {
		description: "Cancel current interaction",
		category: "controls",
	},
	"deselect-all": {
		description: "Deselect all clips",
		category: "selection",
	},
	"duplicate-selected": {
		description: "Duplicate selected clip",
		category: "selection",
	},
	"toggle-clips-muted-selected": {
		description: "Mute/unmute selected clips",
		category: "selection",
	},
	"toggle-clips-visibility-selected": {
		description: "Show/hide selected clips",
		category: "selection",
	},
	"toggle-marker": {
		description: "Toggle marker at playhead",
		category: "timeline",
	},
	undo: {
		description: "Undo",
		category: "history",
	},
	redo: {
		description: "Redo",
		category: "history",
	},
	"remove-project-item": {
		description: "Remove project item",
		category: "projectItems",
		args: { projectId: "string", projectItemId: "string" },
	},
	"remove-project-items": {
		description: "Remove project items",
		category: "projectItems",
		args: { projectId: "string", projectItemIds: "string[]" },
	},
} as const satisfies Record<string, TActionBaseDefinition>;

export type TAction = keyof typeof ACTIONS;

const ACTIONS_WITH_REQUIRED_ARGS: ReadonlySet<string> = new Set<
	Exclude<TActionWithArgs, TActionWithOptionalArgs>
>(["remove-project-item", "remove-project-items"]);

export function isActionWithOptionalArgs(
	value: string,
): value is TActionWithOptionalArgs {
	return Object.hasOwn(ACTIONS, value) && !ACTIONS_WITH_REQUIRED_ARGS.has(value);
}

const ACTION_DEFAULT_SHORTCUTS = [
	["toggle-play", ["space", "k"]],
	["seek-forward", ["l"]],
	["seek-backward", ["j"]],
	["frame-step-forward", ["right"]],
	["frame-step-backward", ["left"]],
	["jump-forward", ["shift+right"]],
	["jump-backward", ["shift+left"]],
	["goto-start", ["home", "enter"]],
	["goto-end", ["end"]],
	["razor", ["s"]],
	["razor-left", ["q"]],
	["razor-right", ["w"]],
	["delete-selected", ["backspace", "delete"]],
	["copy-selected", ["ctrl+c"]],
	["paste-copied", ["ctrl+v"]],
	["toggle-snapping", ["n"]],
	["select-all", ["ctrl+a"]],
	["cancel-interaction", ["escape"]],
	["duplicate-selected", ["ctrl+d"]],
	["undo", ["ctrl+z"]],
	["redo", ["ctrl+shift+z", "ctrl+y"]],
] as const satisfies ReadonlyArray<
	readonly [TActionWithOptionalArgs, readonly ShortcutKey[]]
>;

const ACTION_DEFAULT_SHORTCUTS_BY_ACTION = new Map<
	TAction,
	readonly ShortcutKey[]
>(ACTION_DEFAULT_SHORTCUTS);

export function getActionDefinition({
	action,
}: {
	action: TAction;
}): TActionDefinition {
	return {
		...ACTIONS[action],
		defaultShortcuts: ACTION_DEFAULT_SHORTCUTS_BY_ACTION.get(action),
	};
}

export function getDefaultShortcuts(): Map<
	ShortcutKey,
	TActionWithOptionalArgs
> {
	const shortcuts = new Map<ShortcutKey, TActionWithOptionalArgs>();

	for (const [action, defaultShortcuts] of ACTION_DEFAULT_SHORTCUTS) {
		for (const shortcut of defaultShortcuts) {
			shortcuts.set(shortcut, action);
		}
	}

	return shortcuts;
}
