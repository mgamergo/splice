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

const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installStorage(storage: ReturnType<typeof fakeStorage>) {
	Object.defineProperty(globalThis, "localStorage", {
		value: storage,
		configurable: true,
	});
}

afterEach(() => {
	useAgentBridgeStore.getState().setBlocked(false);
	if (original) {
		Object.defineProperty(globalThis, "localStorage", original);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});

describe("agent Stop", () => {
	test("Stop pressed here blocks the agent even when storage refuses the write", () => {
		installStorage(fakeStorage({ writable: false }));
		useAgentBridgeStore.getState().setBlocked(true);
		expect(isAgentBlocked()).toBe(true);
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
