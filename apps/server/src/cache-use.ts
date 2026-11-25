export type AnalysisCache =
	| "transcripts"
	| "pauses"
	| "loudness"
	| "noise-reduction";

/** Jobs can share a cache. Cleanup skips busy caches and briefly holds idle ones. */
export function createCacheUse() {
	const users = new Map<AnalysisCache, number>();
	const cleaning = new Map<AnalysisCache, Promise<void>>();

	async function acquire(cache: AnalysisCache): Promise<() => void> {
		let cleanup: Promise<void> | undefined;
		while ((cleanup = cleaning.get(cache))) await cleanup;
		users.set(cache, (users.get(cache) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (users.get(cache) ?? 1) - 1;
			if (remaining) users.set(cache, remaining);
			else users.delete(cache);
		};
	}

	return {
		acquire,
		async use<T>({
			cache,
			operation,
		}: {
			cache: AnalysisCache;
			operation: () => Promise<T>;
		}): Promise<T> {
			const release = await acquire(cache);
			try {
				return await operation();
			} finally {
				release();
			}
		},
		async inspect({
			cache,
			operation,
		}: {
			cache: AnalysisCache;
			operation: (busy: boolean) => Promise<void>;
		}) {
			if (users.has(cache)) return operation(true);
			const { promise, resolve } = Promise.withResolvers<void>();
			cleaning.set(cache, promise);
			try {
				await operation(false);
			} finally {
				cleaning.delete(cache);
				resolve();
			}
		},
	};
}

export type CacheUse = ReturnType<typeof createCacheUse>;
