import { copyFile, lstat, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Publish a complete legacy cache entry with an independently removable inode. */
export async function promoteCacheFile({
	legacy,
	target,
	jobPrefix,
	jobFile,
}: {
	legacy: string;
	target: string;
	jobPrefix: string;
	jobFile: string;
}): Promise<void> {
	if (await Bun.file(target).exists()) return;
	const source = await lstat(legacy).catch(() => null);
	if (!source?.isFile()) return;
	const job = await mkdtemp(join(dirname(target), jobPrefix));
	try {
		const temporary = join(job, jobFile);
		await copyFile(legacy, temporary);
		await rename(temporary, target);
	} finally {
		await rm(job, { recursive: true, force: true });
	}
}
