import { describe, expect, test } from "bun:test";
import { Command } from "@/commands/base-command";
import { BatchCommand } from "@/commands/batch-command";

class Recorder extends Command {
	private readonly log: string[];
	private readonly name: string;
	private readonly fail: boolean;

	constructor({ log, name, fail = false }: { log: string[]; name: string; fail?: boolean }) {
		super();
		this.log = log;
		this.name = name;
		this.fail = fail;
	}

	execute() {
		if (this.fail) throw new Error(`${this.name} failed`);
		this.log.push(`do ${this.name}`);
		return undefined;
	}

	undo() {
		this.log.push(`undo ${this.name}`);
	}
}

describe("BatchCommand", () => {
	test("undoes the commands that already ran when a later one throws", () => {
		const log: string[] = [];
		const batch = new BatchCommand([
			new Recorder({ log, name: "a" }),
			new Recorder({ log, name: "b" }),
			new Recorder({ log, name: "c", fail: true }),
			new Recorder({ log, name: "d" }),
		]);

		expect(() => batch.execute()).toThrow("c failed");
		// The failing command is undone too, in case it changed state before throwing.
		expect(log).toEqual(["do a", "do b", "undo c", "undo b", "undo a"]);
	});
});
