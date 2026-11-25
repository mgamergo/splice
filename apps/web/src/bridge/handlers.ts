import type { EditorState, ItemSummary, TabMethod } from "@splice/bridge";
import { mixLoudnessRequestSchema } from "@splice/bridge/mix";
import { z } from "zod";
import type { EditorApi } from "@/agent/editor-api";
import type { EditorCore } from "@/core";
import { importDiskItems, summarizeItem } from "@/media/import-disk";
import { projectFormat, projectShortStyle } from "@/project/format";

export type TabHandlers = Record<TabMethod, (params: unknown) => unknown>;

/** Thrown for malformed params; the bridge reports it as INVALID_PARAMS. */
export class InvalidParamsError extends Error {}

const importItemsSchema = z.strictObject({
	/** Paths relative to the Footage folder, with forward slashes. */
	paths: z.array(z.string().min(1)).min(1).max(200),
});

/** Thrown when the creator has pressed Stop; the bridge reports it as AGENT_BLOCKED. */
export class AgentBlockedError extends Error {
	constructor() {
		super(
			"The creator stopped the agent in the editor. Ask them to allow it again before editing.",
		);
	}
}

export function createTabHandlers({
	editor,
	api,
	isBlocked,
}: {
	editor: EditorCore;
	api: EditorApi;
	isBlocked: () => boolean;
}): TabHandlers {
	const checkAgentAllowed = () => {
		if (isBlocked()) throw new AgentBlockedError();
	};
	return {
		"editor.getState": (): EditorState => {
			const project = editor.project.getActiveOrNull();
			return {
				revision: api.getRevision(),
				project: project
					? {
							id: project.metadata.id,
							name: project.metadata.name,
							format: projectFormat({ project }),
							shortStyle: projectShortStyle({ project }),
						}
					: null,
				sequenceId: editor.sequences.getActiveSequenceOrNull()?.id ?? null,
				digest: api.getDigest(),
			};
		},
		"editor.apply": (params) => {
			if (isBlocked()) {
				throw new AgentBlockedError();
			}
			return api.apply(params);
		},
		"editor.rawSequence": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.rawSequence(params);
		},
		"editor.roughCut": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.roughCut(params);
		},
		"editor.roughCutSources": (params) => api.roughCutSources(params),
		"editor.addCaptions": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.addCaptions(params);
		},
		"editor.captionCues": (params) => api.captionCues(params),
		"editor.correctCaption": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.correctCaption(params);
		},
		"editor.graphicsPlan": (params) => api.graphicsPlan(params),
		"editor.graphicsApply": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.graphicsApply(params);
		},
		"editor.graphicsList": (params) => api.graphicsList(params),
		"editor.shortStyle": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.setShortStyle(params);
		},
		"editor.shortHook": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.setShortHook(params);
		},
		"editor.shortCaptionPlacement": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.setShortCaptionPlacement(params);
		},
		"editor.shortSrt": () => api.shortCaptionSrt(),
		"editor.addMusic": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.addMusic({ request: params, beforeWrite: checkAgentAllowed });
		},
		"editor.updateMusic": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.updateMusic({ request: params, beforeWrite: checkAgentAllowed });
		},
		"editor.removeMusic": (params) => {
			if (isBlocked()) throw new AgentBlockedError();
			return api.removeMusic(params);
		},
		"editor.mixLoudness": (params) => {
			// Measuring only reads; saving the gain is a write.
			if (isBlocked() && mixLoudnessRequestSchema.safeParse(params).data?.apply !== false)
				throw new AgentBlockedError();
			return api.mixLoudness({ request: params, beforeWrite: checkAgentAllowed });
		},
		"editor.mixStatus": (params) => api.mixStatus(params),
		"editor.cutTranscript": (params) => api.cutTranscript(params),
		"editor.transcriptSelection": (params) => api.transcriptSelection(params),
		"editor.takesList": (params) => api.takesList(params),
		"editor.audioSources": (params) => api.audioSources(params),
		"editor.listItems": (): ItemSummary[] =>
			editor.media.getProjectItems().map(summarizeItem),
		"editor.importItems": (params) => {
			if (isBlocked()) {
				throw new AgentBlockedError();
			}
			const parsed = importItemsSchema.safeParse(params);
			if (!parsed.success) {
				throw new InvalidParamsError(
					parsed.error.issues.map((issue) => issue.message).join("; "),
				);
			}
			return importDiskItems({ editor, paths: parsed.data.paths, isBlocked });
		},
	};
}
