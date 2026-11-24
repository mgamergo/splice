type Running<T> = {
	result: Promise<T>;
	abort: AbortController;
	waiting: number;
};

/**
 * Work that every request asking for the same key shares, such as one FFmpeg
 * scan of a file. A request's `signal` ends only its own wait. The work is
 * aborted once every request waiting for it has gone, or when `stop` aborts,
 * and the next request for the key starts it again.
 */
export function createSharedWork<T>({ stop }: { stop: AbortSignal }) {
	const running = new Map<string, Running<T>>();
	return {
		run({
			key,
			signal,
			work,
		}: {
			key: string;
			signal?: AbortSignal;
			work: (signal: AbortSignal) => Promise<T>;
		}): Promise<T> {
			if (signal?.aborted) return Promise.reject(signal.reason);
			let job = running.get(key);
			if (!job) {
				const abort = new AbortController();
				const created: Running<T> = {
					abort,
					waiting: 0,
					result: work(AbortSignal.any([stop, abort.signal])),
				};
				void created.result
					.catch(() => undefined)
					.finally(() => {
						if (running.get(key) === created) running.delete(key);
					});
				running.set(key, created);
				job = created;
			}
			const shared = job;
			shared.waiting++;
			return new Promise<T>((resolve, reject) => {
				let waiting = true;
				function leave() {
					if (!waiting) return false;
					waiting = false;
					signal?.removeEventListener("abort", onAbort);
					shared.waiting--;
					return true;
				}
				function onAbort() {
					if (!leave()) return;
					if (shared.waiting === 0) {
						if (running.get(key) === shared) running.delete(key);
						shared.abort.abort(signal?.reason);
					}
					reject(signal?.reason);
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				shared.result.then(
					(value) => {
						if (leave()) resolve(value);
					},
					(error: unknown) => {
						if (leave()) reject(error);
					},
				);
			});
		},

		/** Settles once all the work running now has. */
		async settled(): Promise<void> {
			await Promise.allSettled(
				Array.from(running.values(), ({ result }) => result),
			);
		},
	};
}
