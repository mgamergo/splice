import type {
	ClipboardEntry,
	ClipboardEntryType,
	ClipboardHandler,
	ClipboardHandlerMap,
	CopyContext,
	PasteContext,
} from "../types";
import { ClipsClipboardHandler } from "./clips";
import { KeyframesClipboardHandler } from "./keyframes";

export const clipboardHandlers = {
	clips: ClipsClipboardHandler,
	keyframes: KeyframesClipboardHandler,
} satisfies ClipboardHandlerMap;

export const clipboardCopyHandlers = [
	KeyframesClipboardHandler,
	ClipsClipboardHandler,
] as const satisfies readonly ClipboardHandler<ClipboardEntryType>[];

export function copyClipboardEntry({
	context,
}: {
	context: CopyContext;
}): ClipboardEntry | null {
	for (const handler of clipboardCopyHandlers) {
		if (!handler.canCopy(context)) {
			continue;
		}

		return handler.copy(context);
	}

	return null;
}

export function buildPasteClipboardCommand({
	entry,
	context,
}: {
	entry: ClipboardEntry;
	context: PasteContext;
}) {
	const handler = clipboardHandlers[entry.type] as ClipboardHandler<
		typeof entry.type
	>;
	return handler.paste({ entry: entry as never, context });
}
