import { storageService } from "@/services/storage/service";
import { callSplice } from "./splice-api";

let sending = false;
let flushRequested = false;

/** Drains only events committed with a project save, in their saved order. */
export async function flushCorrections() {
	if (sending) {
		flushRequested = true;
		return;
	}
	sending = true;
	flushRequested = false;
	try {
		for (;;) {
			const { keys, events } = await storageService.readCorrectionBatch();
			if (!events.length) break;
			await callSplice({ method: "profile.capture", params: { events } });
			await storageService.acknowledgeCorrections({ keys });
		}
	} catch (error) {
		console.warn("Couldn't send editing profile Corrections to splice:", error);
	} finally {
		sending = false;
		if (flushRequested) void flushCorrections();
	}
}
