const MODEL_CACHE = "transformers-cache";
const MODEL_CACHE_LOCK = "splice-transcription-model-cache";

/** Keep downloaded files available until the worker has loaded them into memory. */
export async function loadWithModelCache<T>(
	load: () => Promise<T>,
): Promise<T> {
	if (!navigator.locks) return load();
	return navigator.locks.request(MODEL_CACHE_LOCK, { mode: "shared" }, load);
}

export async function inspectModelCache({ remove = false } = {}) {
	if (!navigator.locks || typeof caches === "undefined") {
		return { kind: "unavailable" } as const;
	}
	return navigator.locks.request(
		MODEL_CACHE_LOCK,
		{ ifAvailable: true },
		async (lock) => {
			if (!lock) return { kind: "busy" } as const;
			if (!(await caches.has(MODEL_CACHE))) {
				return { kind: "ready", items: 0, bytes: 0, removed: false } as const;
			}
			const cache = await caches.open(MODEL_CACHE);
			const keys = await cache.keys();
			let bytes: number | null = 0;
			for (const key of keys) {
				const response = await cache.match(key);
				const length = response?.headers.get("content-length");
				void response?.body?.cancel();
				if (!length || !/^\d+$/.test(length)) {
					bytes = null;
					break;
				}
				bytes += Number(length);
			}
			const removed = remove && (await caches.delete(MODEL_CACHE));
			return { kind: "ready", items: keys.length, bytes, removed } as const;
		},
	);
}
