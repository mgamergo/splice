import { expect, test } from "bun:test";
import { createSharedWork } from "../shared-work";

/** Work that runs until it is aborted, recording each signal it got. */
function blockingWork() {
	const signals: AbortSignal[] = [];
	const work = (signal: AbortSignal) => {
		signals.push(signal);
		return new Promise<string>((_, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			}),
		);
	};
	return { signals, work };
}

test("shares one run per key and stops it once every waiter has gone", async () => {
	const shared = createSharedWork<string>({
		stop: new AbortController().signal,
	});
	const { signals, work } = blockingWork();
	const first = new AbortController();
	const second = new AbortController();
	const a = shared.run({ key: "take.wav", signal: first.signal, work });
	const b = shared.run({ key: "take.wav", signal: second.signal, work });
	expect(signals).toHaveLength(1);

	first.abort(new Error("first hung up"));
	await expect(a).rejects.toThrow("first hung up");
	// The second request still waits, so the scan runs on.
	expect(signals[0].aborted).toBe(false);

	second.abort(new Error("second hung up"));
	await expect(b).rejects.toThrow("second hung up");
	expect(signals[0].aborted).toBe(true);

	// The next request starts the work again instead of joining the aborted run.
	const again = shared.run({
		key: "take.wav",
		work: async () => "scanned",
	});
	expect(await again).toBe("scanned");
	expect(signals).toHaveLength(1);
});

test("a finished run answers every waiter, and stop aborts what runs", async () => {
	const stop = new AbortController();
	const shared = createSharedWork<string>({ stop: stop.signal });
	let finish = (_value: string) => {};
	const work = () =>
		new Promise<string>((resolve) => {
			finish = resolve;
		});
	const waiters = [
		shared.run({ key: "a", work }),
		shared.run({ key: "a", signal: new AbortController().signal, work }),
	];
	finish("done");
	expect(await Promise.all(waiters)).toEqual(["done", "done"]);

	const { signals, work: blocking } = blockingWork();
	const pending = shared.run({ key: "b", work: blocking });
	stop.abort(new Error("stopping"));
	await expect(pending).rejects.toThrow("stopping");
	expect(signals[0].aborted).toBe(true);
	await shared.settled();

	const gone = AbortSignal.abort(new Error("already gone"));
	await expect(shared.run({ key: "c", signal: gone, work })).rejects.toThrow(
		"already gone",
	);
});

test("settled waits for work every waiter left until it has cleaned up", async () => {
	const shared = createSharedWork<string>({
		stop: new AbortController().signal,
	});
	let cleanUp = () => {};
	let cleanedUp = false;
	const work = (signal: AbortSignal) =>
		new Promise<string>((_, reject) =>
			signal.addEventListener(
				"abort",
				() => {
					// Cleanup that outlasts the abort, like removing a temporary folder.
					cleanUp = () => {
						cleanedUp = true;
						reject(signal.reason);
					};
				},
				{ once: true },
			),
		);
	const hangUp = new AbortController();
	const waiter = shared.run({ key: "take.wav", signal: hangUp.signal, work });
	hangUp.abort(new Error("hung up"));
	await expect(waiter).rejects.toThrow("hung up");

	let settled = false;
	const done = shared.settled().then(() => {
		settled = true;
	});
	await Bun.sleep(10);
	expect(settled).toBe(false);
	cleanUp();
	await done;
	expect(cleanedUp).toBe(true);
});
