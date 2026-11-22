import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SequenceTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];
	/** Increments on every execute, undo and redo, so readers can detect change. */
	private revision = 0;

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const beforeTracks = this.isRippleEnabled
			? (this.editor.sequences.getActiveSequenceOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.revision++;
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.history.push({
			command,
			previousSelection,
			selectionOverride,
		});
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push({
			command,
			previousSelection: this.getSelectionSnapshot(),
		});
		this.redoStack = [];
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		entry?.command.undo();
		if (entry) this.revision++;
		if (entry) {
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const beforeTracks = this.isRippleEnabled
			? (this.editor.sequences.getActiveSequenceOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.revision++;
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.history.push({
			command: entry.command,
			previousSelection,
			selectionOverride,
		});
	}

	getRevision(): number {
		return this.revision;
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SequenceTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.sequences.getActiveSequenceOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
