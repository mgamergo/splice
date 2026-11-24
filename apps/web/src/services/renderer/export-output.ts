import type { Output } from "mediabunny";

/** The part of a mediabunny Output that cleaning up after a failed write needs. */
export type CancellableOutput = Pick<Output, "state" | "cancel">;

/**
 * Runs `write` against an output and, if it throws (a cancelled frame read,
 * say), cancels the output before passing the error on. The export settles
 * only once its output is closed, so a replacement export waiting on it never
 * starts while the old output is still open.
 */
export async function writeOutput<T>({
	output,
	write,
}: {
	output: CancellableOutput;
	write: () => Promise<T>;
}): Promise<T> {
	try {
		return await write();
	} catch (error) {
		// A finalizing, finalized or already cancelled output can't be cancelled.
		if (output.state === "pending" || output.state === "started") {
			await output.cancel();
		}
		throw error;
	}
}
