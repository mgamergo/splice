import type { EditorState, TabMethod } from "@splice/bridge";
import type { EditorApi } from "@/agent/editor-api";
import type { EditorCore } from "@/core";

export type TabHandlers = Record<TabMethod, (params: unknown) => unknown>;

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
	return {
		"editor.getState": (): EditorState => {
			const project = editor.project.getActiveOrNull();
			return {
				revision: api.getRevision(),
				project: project
					? { id: project.metadata.id, name: project.metadata.name }
					: null,
				digest: api.getDigest(),
			};
		},
		"editor.apply": (params) => {
			if (isBlocked()) {
				throw new AgentBlockedError();
			}
			return api.apply(params);
		},
	};
}
