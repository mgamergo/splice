import { expect, spyOn, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { EditorApi } from "@/agent/editor-api";
import { setUpEditor } from "@/agent/__tests__/fixtures";
import { EditRemovalMarkerCommand } from "@/commands/sequence/edit-removal-marker";
import { EditorCore } from "@/core";
import { storageService } from "@/services/storage/service";
import { flushCorrections } from "../report-corrections";
import * as spliceApi from "../splice-api";

test("an offline swap survives reload and retries with the saved ID until acknowledged", async () => {
	const previousIndexedDB = Object.getOwnPropertyDescriptor(
		globalThis,
		"indexedDB",
	);
	Object.defineProperty(globalThis, "indexedDB", {
		value: new IDBFactory(),
		configurable: true,
	});
	const editor = setUpEditor({ tracks: {} });
	editor.save.stop();
	const api = new EditorApi(editor);
	const call = spyOn(spliceApi, "callSplice").mockRejectedValueOnce(
		new Error("Splice stopped"),
	);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		editor.media.setProjectItems({
			projectItems: [
				{
					id: "rec",
					name: "talk.wav",
					type: "audio",
					duration: 20,
					hasAudio: true,
					file: new File([], "talk.wav"),
				},
			],
		});
		expect(
			api.rawSequence({ projectItemIds: ["rec"], expectedRevision: 0 }),
		).toMatchObject({ ok: true });
		expect(
			api.roughCut({
				expectedRevision: api.getRevision(),
				sections: [
					{
						name: "Intro",
						bestTakeIndex: 1,
						takes: [
							{ projectItemId: "rec", sourceIn: 2, sourceOut: 7 },
							{ projectItemId: "rec", sourceIn: 10, sourceOut: 15 },
						],
					},
				],
			}),
		).toMatchObject({ ok: true });
		const { id: sequenceId, markers } = editor.sequences.getActiveSequence();
		const markerId = markers[0].id;
		if (!markerId) throw new Error("Expected a removal marker");
		editor.command.execute({
			command: new EditRemovalMarkerCommand({
				editor,
				edit: { op: "swap_take", markerId, takeIndex: 0 },
			}),
		});

		const projectId = "project-1";
		const events = editor.command.getUnsavedCorrections({ projectId });
		expect(events.map(({ kind }) => kind)).toEqual(["swap_take"]);
		expect(await storageService.readCorrectionBatch()).toEqual({
			keys: [],
			events: [],
		});
		await editor.project.saveCurrentProject();
		expect(editor.command.getUnsavedCorrections({ projectId })).toEqual([]);
		EditorCore.reset();

		const restored = await storageService.loadProject({ id: projectId });
		const sequence = restored?.project.sequences.find(
			({ id }) => id === sequenceId,
		);
		expect(sequence?.markers[0].data).toMatchObject({
			bestTake: { projectItemId: "rec", sourceIn: 2, sourceOut: 7 },
		});
		await flushCorrections();
		expect((await storageService.readCorrectionBatch()).events).toEqual(events);

		const started = Promise.withResolvers<void>();
		const acknowledgement = Promise.withResolvers<unknown>();
		call.mockImplementationOnce(() => {
			started.resolve();
			return acknowledgement.promise;
		});
		const replay = flushCorrections();
		await started.promise;
		expect((await storageService.readCorrectionBatch()).events).toEqual(events);
		acknowledgement.resolve({ recorded: 1 });
		await replay;
		expect(call.mock.calls).toEqual([
			[{ method: "profile.capture", params: { events } }],
			[{ method: "profile.capture", params: { events } }],
		]);
		expect(await storageService.readCorrectionBatch()).toEqual({
			keys: [],
			events: [],
		});
	} finally {
		call.mockRestore();
		warn.mockRestore();
		EditorCore.reset();
		if (previousIndexedDB) {
			Object.defineProperty(globalThis, "indexedDB", previousIndexedDB);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
	}
});
