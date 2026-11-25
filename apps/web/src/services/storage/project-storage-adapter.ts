import {
	correctionEventSchema,
	type CorrectionEvent,
} from "@splice/bridge/profile";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import type { SerializedProject } from "./types";

const PROJECTS = "projects";
const OUTBOX = "correction-outbox";

function committed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("Project storage write aborted."));
	});
}

export class ProjectStorageAdapter extends IndexedDBAdapter<SerializedProject> {
	constructor({ dbName }: { dbName: string }) {
		super({ dbName, storeName: PROJECTS, version: 2 });
	}

	protected override upgrade(db: IDBDatabase): void {
		if (!db.objectStoreNames.contains(OUTBOX)) {
			// Increasing keys preserve the edit, undo and redo order across saves.
			db.createObjectStore(OUTBOX, { autoIncrement: true });
		}
	}

	async save({
		project,
		events,
	}: {
		project: SerializedProject;
		events: CorrectionEvent[];
	}): Promise<void> {
		const id = project.metadata.id;
		if (!events.length) return this.set({ key: id, value: project });
		const db = await this.getDB();
		const transaction = db.transaction([PROJECTS, OUTBOX], "readwrite", {
			durability: "strict",
		});
		db.close();
		const outbox = transaction.objectStore(OUTBOX);
		try {
			transaction.objectStore(PROJECTS).put({ id, ...project });
			for (const event of events) outbox.add(event);
		} catch (error) {
			transaction.abort();
			throw error;
		}
		await committed(transaction);
	}

	async readCorrectionBatch(): Promise<{
		keys: IDBValidKey[];
		events: CorrectionEvent[];
	}> {
		const db = await this.getDB();
		const transaction = db.transaction(OUTBOX, "readonly");
		db.close();
		const outbox = transaction.objectStore(OUTBOX);
		const keys = outbox.getAllKeys(undefined, 100);
		const entries = outbox.getAll(undefined, 100);
		await committed(transaction);
		return {
			keys: keys.result,
			events: correctionEventSchema.array().parse(entries.result),
		};
	}

	async acknowledgeCorrections({
		keys,
	}: {
		keys: IDBValidKey[];
	}): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction(OUTBOX, "readwrite", {
			durability: "strict",
		});
		db.close();
		const outbox = transaction.objectStore(OUTBOX);
		for (const key of keys) outbox.delete(key);
		await committed(transaction);
	}
}
