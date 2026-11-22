import { Command, type CommandResult } from "@/commands/base-command";
import type { SequenceTracks } from "@/timeline";
import { EditorCore } from "@/core";

export class TracksSnapshotCommand extends Command {
	constructor({
		before,
		after,
	}: {
		before: SequenceTracks;
		after: SequenceTracks;
	}) {
		super();
		this.before = before;
		this.after = after;
	}

	private before: SequenceTracks;
	private after: SequenceTracks;

	execute(): CommandResult | undefined {
		EditorCore.getInstance().timeline.updateTracks(this.after);
		return undefined;
	}

	undo(): void {
		EditorCore.getInstance().timeline.updateTracks(this.before);
	}
}
