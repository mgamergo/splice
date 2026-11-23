import { describe, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { AgentBlockedError, createTabHandlers } from "../handlers";

function setUp({ blocked = false } = {}) {
	const editor = setUpEditor({ tracks: {} });
	const sequence = editor.sequences.getActiveSequence();
	editor.timeline.updateTracks({
		...sequence.tracks,
		main: {
			...sequence.tracks.main,
			clips: [videoClip({ id: "a", start: 0, duration: 10 })],
		},
	});
	const api = new EditorApi(editor);
	return {
		editor,
		handlers: createTabHandlers({ editor, api, isBlocked: () => blocked }),
	};
}

describe("tab handlers", () => {
	test("getState reports the project, revision and digest", () => {
		const { handlers } = setUp();
		const state = handlers["editor.getState"](undefined);
		expect(state).toMatchObject({
			revision: 0,
			project: { id: "project-1", name: "Test" },
		});
		expect(JSON.stringify(state)).toContain("a");
	});

	test("apply runs through the editing API", () => {
		const { editor, handlers } = setUp();
		const result = handlers["editor.apply"]({
			expectedRevision: 0,
			label: "Mark",
			ops: [{ op: "add_marker", at: { seconds: 2 } }],
		});
		expect(result).toMatchObject({ ok: true, revision: 1 });
		expect(editor.sequences.getActiveSequence().markers).toHaveLength(1);
	});

	test("apply is refused while the creator has stopped the agent", () => {
		const { editor, handlers } = setUp({ blocked: true });
		expect(() =>
			handlers["editor.apply"]({
				expectedRevision: 0,
				label: "Mark",
				ops: [{ op: "add_marker", at: { seconds: 2 } }],
			}),
		).toThrow(AgentBlockedError);
		expect(editor.sequences.getActiveSequence().markers).toHaveLength(0);
		expect(editor.command.getRevision()).toBe(0);
	});
});
