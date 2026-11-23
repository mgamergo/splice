import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import { importDiskItems, type ImportReaders } from "../import-disk";
import type { DiskMedia, ProjectItem } from "../types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const media = ({ path }: { path: string }): DiskMedia => ({
	kind: "disk",
	path,
	url: `/splice/media/${path}`,
	name: path,
	type: "audio/wav",
	size: 1,
	lastModified: 0,
});

/** A project library that saves like MediaManager: the item shows before the save settles. */
function fakeEditor({ save }: { save: () => Promise<boolean> }) {
	const items: ProjectItem[] = [];
	let generation = 0;
	let added = 0;
	const editor = {
		project: { getActiveOrNull: () => ({ metadata: { id: "project-1" } }) },
		media: {
			getGeneration: () => generation,
			getProjectItems: () => items,
			addProjectItem: async ({
				projectItem,
			}: {
				projectItem: Omit<ProjectItem, "id">;
			}) => {
				added++;
				const item = { ...projectItem, id: `item-${added}` };
				items.push(item);
				if (await save()) return item;
				items.splice(items.indexOf(item), 1);
				return null;
			},
		},
	};
	return {
		editor: editor as unknown as EditorCore,
		items,
		addedCount: () => added,
		clearLibrary: () => {
			generation++;
		},
	};
}

const readers = (describeGate?: Promise<void>): ImportReaders => ({
	probe: async ({ path }) => media({ path }),
	describe: async ({ media: file, type }) => {
		await describeGate;
		return { name: file.name, type, file, url: file.url, duration: 3 };
	},
});

describe("importDiskItems", () => {
	test("an import that overlaps a failing save reports the failure, not a phantom item", async () => {
		const saved = deferred<boolean>();
		const fake = fakeEditor({ save: () => saved.promise });
		const first = importDiskItems({
			editor: fake.editor,
			paths: ["vo.wav"],
			isBlocked: () => false,
			readers: readers(),
		});
		// The item is in the library while its save is pending.
		while (fake.items.length === 0) await Bun.sleep(1);
		const second = importDiskItems({
			editor: fake.editor,
			paths: ["vo.wav"],
			isBlocked: () => false,
			readers: readers(),
		});
		saved.resolve(false);

		for (const result of await Promise.all([first, second])) {
			expect(result.imported).toEqual([]);
			expect(result.failed).toEqual([
				{ path: "vo.wav", error: "Couldn't save the project item" },
			]);
		}
		expect(fake.addedCount()).toBe(1);
	});

	test("an import abandons its item when the library is cleared mid-probe", async () => {
		const probed = deferred<void>();
		const fake = fakeEditor({ save: async () => true });
		const pending = importDiskItems({
			editor: fake.editor,
			paths: ["vo.wav"],
			isBlocked: () => false,
			readers: readers(probed.promise),
		});
		fake.clearLibrary();
		probed.resolve();

		const result = await pending;
		expect(result.imported).toEqual([]);
		expect(result.failed[0]?.error).toContain("switched the project");
		expect(fake.addedCount()).toBe(0);
	});

	test("Stop pressed during the probe keeps the item out", async () => {
		const probed = deferred<void>();
		let blocked = false;
		const fake = fakeEditor({ save: async () => true });
		const pending = importDiskItems({
			editor: fake.editor,
			paths: ["vo.wav"],
			isBlocked: () => blocked,
			readers: readers(probed.promise),
		});
		blocked = true;
		probed.resolve();

		expect((await pending).failed[0]?.error).toBe(
			"The creator stopped the agent",
		);
		expect(fake.addedCount()).toBe(0);
	});
});
