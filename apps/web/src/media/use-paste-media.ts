import { useEffect } from "react";
import { useEditor } from "@/editor/use-editor";
import { processProjectItems } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import { buildClipFromMedia } from "@/timeline/clip-utils";
import { AddProjectItemCommand } from "@/commands/media";
import { InsertClipCommand } from "@/commands/timeline";
import { BatchCommand } from "@/commands";
import { DEFAULT_NEW_CLIP_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds } from "@/wasm";
import { isTypableDOMElement } from "@/utils/browser";
import type { MediaType } from "@/media/types";

const MEDIA_MIME_PREFIXES: MediaType[] = ["image", "video", "audio"];

function isMediaMimeType({ type }: { type: string }): boolean {
	return MEDIA_MIME_PREFIXES.some((prefix) => type.startsWith(`${prefix}/`));
}

function extractMediaFilesFromClipboard({
	clipboardData,
}: {
	clipboardData: DataTransfer | null;
}): File[] {
	if (!clipboardData?.items) return [];

	const files: File[] = [];
	for (const item of clipboardData.items) {
		if (item.kind !== "file") continue;
		if (!isMediaMimeType({ type: item.type })) continue;

		const file = item.getAsFile();
		if (file) files.push(file);
	}
	return files;
}

export function usePasteMedia() {
	const editor = useEditor();

	useEffect(() => {
		const handlePaste = async (event: ClipboardEvent) => {
			const activeElement = document.activeElement as HTMLElement;

			if (activeElement && isTypableDOMElement({ clip: activeElement })) {
				return;
			}

			const files = extractMediaFilesFromClipboard({
				clipboardData: event.clipboardData,
			});
			if (files.length === 0) {
				event.preventDefault();
				editor.clipboard.paste();
				return;
			}

			event.preventDefault();

			const activeProject = editor.project.getActive();
			if (!activeProject) return;

			try {
				await showMediaUploadToast({
					filesCount: files.length,
					promise: async () => {
						const processedProjectItems = await processProjectItems({ files });
						const startTime = editor.playback.getCurrentTime();

						for (const projectItem of processedProjectItems) {
							const addMediaCmd = new AddProjectItemCommand({
								projectId: activeProject.metadata.id,
								projectItem,
							});
							const projectItemId = addMediaCmd.getProjectItemId();
							const duration =
								projectItem.duration != null
									? mediaTimeFromSeconds({ seconds: projectItem.duration })
									: DEFAULT_NEW_CLIP_DURATION;
							const trackType = projectItem.type === "audio" ? "audio" : "video";

							const clip = buildClipFromMedia({
								mediaId: projectItemId,
								mediaType: projectItem.type,
								name: projectItem.name,
								duration,
								startTime,
								buffer:
									projectItem.type === "audio"
										? new AudioBuffer({ length: 1, sampleRate: 44100 })
										: undefined,
							});

							const insertCmd = new InsertClipCommand({
								clip,
								placement: { mode: "auto", trackType },
							});
							const batchCmd = new BatchCommand([addMediaCmd, insertCmd]);
							editor.command.execute({ command: batchCmd });
						}

						return {
							uploadedCount: processedProjectItems.length,
							projectItemNames: processedProjectItems.map((projectItem) => projectItem.name),
						};
					},
				});
			} catch (error) {
				console.error("Failed to paste media:", error);
			}
		};

		window.addEventListener("paste", handlePaste);
		return () => window.removeEventListener("paste", handlePaste);
	}, [editor]);
}
