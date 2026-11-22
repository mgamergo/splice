/**
 * Version of the saved project format. Splice starts a fresh format at 1 and
 * does not load projects saved by OpenCut. Bump this only together with a
 * migration for the previous version.
 */
export const PROJECT_FORMAT_VERSION = 1;

export function isSupportedProjectFormat({
	version,
}: {
	version: unknown;
}): boolean {
	return version === PROJECT_FORMAT_VERSION;
}
