import { Command, type CommandResult } from "./base-command";

export class BatchCommand extends Command {
	constructor(private commands: Command[]) {
		super();
	}

	/** All or nothing: if a command throws, the ones before it are undone. */
	execute(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;
		const executed: Command[] = [];

		try {
			for (const command of this.commands) {
				const result = command.execute();
				executed.push(command);
				if (result?.selection !== undefined) {
					latestSelectionResult = result;
				}
			}
		} catch (error) {
			for (const command of executed.reverse()) {
				command.undo();
			}
			throw error;
		}

		return latestSelectionResult;
	}

	undo(): void {
		for (const command of [...this.commands].reverse()) {
			command.undo();
		}
	}

	redo(): CommandResult | undefined {
		let latestSelectionResult: CommandResult | undefined;

		for (const command of this.commands) {
			const result = command.redo();
			if (result?.selection !== undefined) {
				latestSelectionResult = result;
			}
		}

		return latestSelectionResult;
	}
}
