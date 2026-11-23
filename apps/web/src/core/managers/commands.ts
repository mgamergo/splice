import type { EditorCore } from "@/core";
import {
	type Command,
	type CommandResult,
	createClipSelectionResult,
} from "@/commands/base-command";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SequenceTracks } from "@/timeline/types";

interface CommandHistoryEntry {
	command: Command;
	sequenceId: string | undefined;
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
	private revisionListeners = new Set<(revision: number) => void>();

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const sequenceId = this.editor.sequences.getActiveSequenceOrNull()?.id;
		const beforeTracks = this.shouldRipple({ command })
			? (this.editor.sequences.getActiveSequenceOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = command.execute();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.history.push({
			command,
			sequenceId,
			previousSelection,
			selectionOverride,
		});
		this.redoStack = [];
		this.bumpRevision();
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push({
			command,
			sequenceId: this.editor.sequences.getActiveSequenceOrNull()?.id,
			previousSelection: this.getSelectionSnapshot(),
		});
		this.redoStack = [];
		// The change was already applied (e.g. a committed drag preview), but it's still an edit.
		this.bumpRevision();
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		if (entry) {
			this.activateHistorySequence({ sequenceId: entry.sequenceId });
			entry.command.undo();
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
			this.bumpRevision();
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		this.activateHistorySequence({ sequenceId: entry.sequenceId });
		const beforeTracks = this.shouldRipple({ command: entry.command })
			? (this.editor.sequences.getActiveSequenceOrNull()?.tracks ?? null)
			: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo();
		this.applyRippleIfEnabled({ beforeTracks });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();

		this.history.push({
			command: entry.command,
			sequenceId: entry.sequenceId,
			previousSelection,
			selectionOverride,
		});
		this.bumpRevision();
	}

	private activateHistorySequence({
		sequenceId,
	}: {
		sequenceId: string | undefined;
	}): void {
		const manager = this.editor.sequences;
		if (!sequenceId || manager.getActiveSequenceOrNull()?.id === sequenceId)
			return;
		const sequences = manager.getSequences();
		// A sequence-deletion command may restore its target during undo.
		if (!sequences.some(({ id }) => id === sequenceId)) return;
		manager.setSequences({ sequences, activeSequenceId: sequenceId });
		this.applySelectionOverride(createClipSelectionResult([]));
	}

	private shouldRipple({ command }: { command: Command }): boolean {
		return this.isRippleEnabled && !command.ignoresRippleToggle;
	}

	getRevision(): number {
		return this.revision;
	}

	/**
	 * Moves the revision forward to at least `revision`. The bridge seeds it from
	 * the clock when a tab connects, so a revision read before a reload can never
	 * match one after it, even though the reloaded tab starts a fresh history.
	 */
	advanceRevisionTo({ revision }: { revision: number }): void {
		if (revision > this.revision) {
			this.revision = revision;
		}
	}

	/** Called after every change to the revision, once the change has fully applied. */
	subscribeRevision(listener: (revision: number) => void): () => void {
		this.revisionListeners.add(listener);
		return () => this.revisionListeners.delete(listener);
	}

	bumpRevision(): void {
		this.revision++;
		for (const listener of this.revisionListeners) {
			listener(this.revision);
		}
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
