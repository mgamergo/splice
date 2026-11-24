import { describe, expect, test } from "bun:test";
import { ExportJobs } from "@/export/export-jobs";
import { type CancellableOutput, writeOutput } from "../export-output";

/** An output whose cancel the test finishes, recording what happened in order. */
function fakeOutput({ events }: { events: string[] }) {
	let finishCancel = () => {};
	const output: CancellableOutput = {
		state: "started",
		cancel: () => {
			output.state = "canceled";
			events.push("cancel started");
			return new Promise<void>((resolve) => {
				finishCancel = () => {
					events.push("cancel finished");
					resolve();
				};
			});
		},
	};
	return { output, finishCancel: () => finishCancel() };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("writeOutput", () => {
	test("a failed frame cancels the output before a replacement export starts", async () => {
		const events: string[] = [];
		const jobs = new ExportJobs();
		const { output, finishCancel } = fakeOutput({ events });
		const readCancelled = new DOMException("Read cancelled", "AbortError");

		const first = jobs.start({
			run: () =>
				writeOutput({
					output,
					write: async () => {
						// The frame read rejects, as a cancelled read does.
						throw readCancelled;
					},
				}),
		});
		const second = jobs.start({
			run: async () => {
				events.push("replacement started");
				return null;
			},
		});
		await flush();

		// The old output is still closing, so the replacement waits.
		expect(events).toEqual(["cancel started"]);
		expect(jobs.isRunning()).toBe(true);

		finishCancel();
		await expect(first).rejects.toBe(readCancelled);
		await second;
		expect(events).toEqual([
			"cancel started",
			"cancel finished",
			"replacement started",
		]);
		expect(jobs.isRunning()).toBe(false);
	});

	test("leaves an output alone once it has been finalized or cancelled", async () => {
		for (const state of ["finalizing", "finalized", "canceled"] as const) {
			const events: string[] = [];
			const { output } = fakeOutput({ events });
			output.state = state;
			const error = new Error("finalize failed");

			await expect(
				writeOutput({
					output,
					write: async () => {
						throw error;
					},
				}),
			).rejects.toBe(error);
			expect(events).toEqual([]);
		}
	});

	test("returns what the write produced without cancelling", async () => {
		const events: string[] = [];
		const { output } = fakeOutput({ events });
		expect(await writeOutput({ output, write: async () => 42 })).toBe(42);
		expect(events).toEqual([]);
	});
});
