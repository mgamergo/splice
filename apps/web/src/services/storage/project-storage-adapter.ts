import {
	correctionEventSchema,
	type CorrectionEvent,
} from "@splice/bridge/profile";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import type { ProjectItemData, SerializedProject } from "./types";

const PROJECTS = "projects";
const OUTBOX = "correction-outbox";
const RECORDINGS = "recordings";

function committed(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("Project storage write aborted."));
	});
}

export class ProjectStorageAdapter extends IndexedDBAdapter<SerializedProject> {
	constructor({ dbName }: { dbName: string }) {
		super({ dbName, storeName: PROJECTS, version: 3 });
	}

	protected override upgrade(db: IDBDatabase): void {
		if (!db.objectStoreNames.contains(RECORDINGS))
			db.createObjectStore(RECORDINGS);
		if (!db.objectStoreNames.contains(OUTBOX)) {
			// Increasing keys preserve the edit, undo and redo order across saves.
			db.createObjectStore(OUTBOX, { autoIncrement: true });
		}
	}

	async save({
		project,
		events,
		recording,
	}: {
		project: SerializedProject;
		events: CorrectionEvent[];
		recording?: ProjectItemData;
	}): Promise<void> {
		const id = project.metadata.id;
		if (!events.length && !recording)
			return this.set({ key: id, value: project });
		const db = await this.getDB();
		const transaction = db.transaction(
			[PROJECTS, OUTBOX, RECORDINGS],
			"readwrite",
			{
				durability: "strict",
			},
		);
		db.close();
		const outbox = transaction.objectStore(OUTBOX);
		try {
			transaction.objectStore(PROJECTS).put({ id, ...project });
			if (recording)
				transaction.objectStore(RECORDINGS).put(recording, [id, recording.id]);
			for (const event of events) outbox.add(event);
		} catch (error) {
			transaction.abort();
			throw error;
		}
		await committed(transaction);
	}

	async readRecordings({
		projectId,
	}: {
		projectId: string;
	}): Promise<ProjectItemData[]> {
		const db = await this.getDB();
		const transaction = db.transaction(RECORDINGS, "readonly");
		db.close();
		const request = transaction
			.objectStore(RECORDINGS)
			.getAll(IDBKeyRange.bound([projectId], [projectId, []], true, true));
		await committed(transaction);
		return request.result;
	}

	async readRecording({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<ProjectItemData | null> {
		const db = await this.getDB();
		const transaction = db.transaction(RECORDINGS, "readonly");
		db.close();
		const request = transaction.objectStore(RECORDINGS).get([projectId, id]);
		await committed(transaction);
		return request.result ?? null;
	}

	async writeRecording({
		projectId,
		recording,
	}: {
		projectId: string;
		recording: ProjectItemData;
	}): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction(RECORDINGS, "readwrite", {
			durability: "strict",
		});
		db.close();
		transaction
			.objectStore(RECORDINGS)
			.put(recording, [projectId, recording.id]);
		await committed(transaction);
	}

	async removeRecordings({
		projectId,
		id,
	}: {
		projectId: string;
		id?: string;
	}): Promise<void> {
		const db = await this.getDB();
		const transaction = db.transaction(RECORDINGS, "readwrite");
		db.close();
		transaction
			.objectStore(RECORDINGS)
			.delete(
				id === undefined
					? IDBKeyRange.bound([projectId], [projectId, []], true, true)
					: [projectId, id],
			);
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
