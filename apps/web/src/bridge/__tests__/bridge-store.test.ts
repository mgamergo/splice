import { afterEach, describe, expect, test } from "bun:test";
import {
	BLOCKED_STORAGE_KEY,
	isAgentBlocked,
	useAgentBridgeStore,
} from "../bridge-store";

function fakeStorage({ writable }: { writable: boolean }) {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		// Mirrors the Storage API.
		// eslint-disable-next-line opencut/prefer-object-params
		setItem: (key: string, value: string) => {
			if (!writable) throw new Error("QuotaExceededError");
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		values,
	};
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

/** Stands in for `window.localStorage`, the only storage the store reads. */
function installStorage(storage: ReturnType<typeof fakeStorage>) {
	Object.defineProperty(globalThis, "window", {
		value: { localStorage: storage },
		configurable: true,
	});
}

afterEach(() => {
	useAgentBridgeStore.getState().setBlocked(false);
	if (originalWindow) {
		Object.defineProperty(globalThis, "window", originalWindow);
	} else {
		Reflect.deleteProperty(globalThis, "window");
	}
});

describe("agent Stop", () => {
	test("Stop pressed here blocks the agent even when storage refuses the write", () => {
		installStorage(fakeStorage({ writable: false }));
		useAgentBridgeStore.getState().setBlocked(true);
		expect(isAgentBlocked()).toBe(true);
	});

	test("an unsaved Stop survives syncing with storage", () => {
		installStorage(fakeStorage({ writable: false }));
		useAgentBridgeStore.getState().setBlocked(true);
		useAgentBridgeStore.getState().syncBlocked();
		expect(useAgentBridgeStore.getState().blocked).toBe(true);
	});

	test("Stop pressed in another tab blocks this one before it syncs", () => {
		const storage = fakeStorage({ writable: true });
		installStorage(storage);
		storage.values.set(BLOCKED_STORAGE_KEY, "true");
		expect(useAgentBridgeStore.getState().blocked).toBe(false);
		expect(isAgentBlocked()).toBe(true);
	});

	test("Allow clears the shared flag", () => {
		const storage = fakeStorage({ writable: true });
		installStorage(storage);
		useAgentBridgeStore.getState().setBlocked(true);
		expect(storage.values.get(BLOCKED_STORAGE_KEY)).toBe("true");
		useAgentBridgeStore.getState().setBlocked(false);
		expect(isAgentBlocked()).toBe(false);
	});
});
