import { Database } from "bun:sqlite";
import { join } from "node:path";

export const ROOT_LOCK_FILE = "runtime.sqlite";

/** SQLite's file lock is released by the OS even if splice exits unexpectedly. */
export function lockRoot({ root }: { root: string }): () => void {
	const lock = new Database(join(root, "Cache", ROOT_LOCK_FILE));
	try {
		lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
	} catch (error) {
		lock.close();
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "SQLITE_BUSY"
		)
			throw new Error(
				`Splice is already using ${root}. Use the running instance or choose another SPLICE_ROOT.`,
			);
		throw error;
	}
	return () => lock.close();
}
