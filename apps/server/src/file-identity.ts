import type { Stats } from "node:fs";

/** A file's size, times and inode, which change when it is rewritten. */
export type FileIdentity = Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "ino">;

/**
 * The parts of a file's identity cache keys use. The inode and change time
 * also catch rewrites that keep the size and restore the modified time, since
 * nothing can set the change time back.
 */
export function fileIdentity({
	size,
	mtimeMs,
	ctimeMs,
	ino,
}: FileIdentity): number[] {
	return [size, mtimeMs, ctimeMs, ino];
}

/** Whether two stats describe the same file, unchanged. */
export function sameFileIdentity({
	a,
	b,
}: {
	a: FileIdentity;
	b: FileIdentity;
}): boolean {
	return fileIdentity(a).join() === fileIdentity(b).join();
}
