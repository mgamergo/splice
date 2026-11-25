import type { Correction } from "@splice/bridge/profile";
import { callSplice } from "./splice-api";

const outbox: Correction[] = [];
let sending = false;

export function reportCorrections(corrections: Correction[]) {
	outbox.push(...corrections);
	void flushCorrections();
}

/** Retries with the same IDs when the editor next connects or records a Correction. */
export async function flushCorrections() {
	if (sending || !outbox.length) return;
	sending = true;
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
	}
}
