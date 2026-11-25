import type { Correction } from "@splice/bridge/profile";
import { callSplice } from "./splice-api";

const outbox: Correction[] = [];
let sending = false;
let flushRequested = false;

export function reportCorrections(corrections: Correction[]) {
	outbox.push(...corrections);
	void flushCorrections();
}

/** Retries with the same IDs when the editor next connects or records a Correction. */
export async function flushCorrections() {
	if (sending) {
		flushRequested = true;
		return;
	}
	if (!outbox.length) return;
	sending = true;
	flushRequested = false;
	try {
		while (outbox.length) {
			const corrections = outbox.slice(0, 100);
			await callSplice({ method: "profile.capture", params: { corrections } });
			outbox.splice(0, corrections.length);
		}
	} catch (error) {
		console.warn("Couldn't send editing profile Corrections to splice:", error);
	} finally {
		sending = false;
		if (flushRequested) void flushCorrections();
	}
}
