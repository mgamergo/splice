import { expect, test } from "bun:test";
import { setUpEditor } from "@/agent/__tests__/fixtures";
import { EditorApi } from "@/agent/editor-api";
import { createTabHandlers, AgentBlockedError } from "@/bridge/handlers";

test("project brief writes require the current project and revision and leave the edit intact", () => {
	const editor = setUpEditor({ tracks: {} });
	editor.save.pause();
	const api = new EditorApi(editor);
	const before = editor.project.getActive();
	const args = {
		projectId: before.metadata.id,
		expectedRevision: api.getRevision(),
		brief: {
			text: " Explain the setup. ",
			audience: "Beginners",
			mustKeepPoints: ["Setup"],
		},
	};
	expect(api.briefGet()).toMatchObject({ brief: null });
	expect(api.briefSet({ ...args, projectId: "other" })).toMatchObject({
		code: "REVISION_CONFLICT",
	});
	expect(
		api.briefSet({
			...args,
			brief: { ...args.brief, mustKeepPoints: ["Setup\nPayoff"] },
		}),
	).toMatchObject({ code: "INVALID_REQUEST" });
	expect(api.briefSet(args)).toMatchObject({
		ok: true,
		revision: args.expectedRevision + 1,
		brief: { ...args.brief, text: "Explain the setup." },
	});
	expect(editor.project.getActive().settings).toBe(before.settings);
	expect(editor.project.getActive().sequences).toBe(before.sequences);
	expect(editor.command.canUndo()).toBe(false);
	expect(api.briefSet({ ...args, brief: null })).toMatchObject({
		code: "REVISION_CONFLICT",
	});
	expect(
		api.briefSet({ ...args, expectedRevision: api.getRevision(), brief: null }),
	).toMatchObject({
		ok: true,
		brief: null,
	});
});

test("Stop blocks brief writes while the agent can still read the brief", () => {
	const editor = setUpEditor({ tracks: {} });
	const api = new EditorApi(editor);
	const handlers = createTabHandlers({ editor, api, isBlocked: () => true });
	expect(handlers["editor.briefGet"](undefined)).toMatchObject({
		ok: true,
		brief: null,
	});
	expect(() => handlers["editor.briefSet"]({})).toThrow(AgentBlockedError);
});
