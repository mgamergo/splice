import { describe, expect, test } from "bun:test";
import type { EditorCore } from "@/core";
import type { ExportResult } from "@/export";
import { ProjectManager } from "@/core/managers/project-manager";

/** One call to the fake renderer's exportProject, finished by the test. */
interface FakeExport {
	signal: AbortSignal;
	onProgress?: ({ progress }: { progress: number }) => void;
	finish: (result: ExportResult) => void;
}

/** A ProjectManager whose renderer records each export and lets the test finish it. */
function setup() {
	const exports: FakeExport[] = [];
	const editor = {
		renderer: {
			exportProject: ({
				signal,
				onProgress,
			}: {
				signal: AbortSignal;
				onProgress?: ({ progress }: { progress: number }) => void;
			}) =>
				new Promise<ExportResult>((finish) => {
					exports.push({ signal, onProgress, finish });
				}),
		},
	};
	// The export path only reaches the renderer.
	const project = new ProjectManager(editor as unknown as EditorCore);
	return { project, exports };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS = { format: "mp4", quality: "high" } as const;

describe("ProjectManager export", () => {
	test("a restarted export waits for the cancelled one to stop drawing", async () => {
		const { project, exports } = setup();

		const first = project.export({ options: OPTIONS });
		await flush();
		expect(exports).toHaveLength(1);

		// Closing the dialog cancels the export and clears its state...
		project.cancelExport();
		project.clearExportState();
		expect(exports[0].signal.aborted).toBe(true);
		expect(project.getExportState().isExporting).toBe(false);
		// ...but the cancelled export still holds the canvas until it stops.
		expect(project.isExportRunning()).toBe(true);

		const second = project.export({ options: OPTIONS });
		await flush();
		// The second export doesn't draw while the first is still stopping.
		expect(exports).toHaveLength(1);

		exports[0].finish({ success: false, cancelled: true });
		expect(await first).toEqual({ success: false, cancelled: true });
		await flush();
		expect(exports).toHaveLength(2);
		expect(exports[1].signal.aborted).toBe(false);
		// The first export's end leaves the second one's state alone.
		expect(project.getExportState().isExporting).toBe(true);
		expect(project.isExportRunning()).toBe(true);

		exports[1].onProgress?.({ progress: 0.5 });
		expect(project.getExportState().progress).toBe(0.5);

		const buffer = new ArrayBuffer(8);
		exports[1].finish({ success: true, buffer });
		expect(await second).toEqual({ success: true, buffer });
		expect(project.getExportState()).toMatchObject({
			isExporting: false,
			result: { success: true },
		});
		expect(project.isExportRunning()).toBe(false);
	});

	test("ignores progress and results from an export another one replaced", async () => {
		const { project, exports } = setup();

		const first = project.export({ options: OPTIONS });
		await flush();
		const second = project.export({ options: OPTIONS });
		await flush();
		// Starting the second cancels the first through its own signal.
		expect(exports[0].signal.aborted).toBe(true);

		// The first export reports a frame and even finishes before it notices.
		exports[0].onProgress?.({ progress: 0.9 });
		expect(project.getExportState()).toMatchObject({
			isExporting: true,
			progress: 0,
		});
		exports[0].finish({ success: true, buffer: new ArrayBuffer(8) });
		expect(await first).toEqual({ success: false, cancelled: true });
		expect(project.getExportState()).toMatchObject({
			isExporting: true,
			result: null,
		});

		await flush();
		expect(exports).toHaveLength(2);
		exports[1].finish({ success: false, cancelled: true });
		expect(await second).toEqual({ success: false, cancelled: true });
		expect(project.getExportState()).toEqual({
			isExporting: false,
			progress: 0,
			result: null,
		});
	});

	test("a finished export replaced before it publishes leaves the state and download to the replacement", async () => {
		const { project, exports } = setup();
		const downloaded: ArrayBuffer[] = [];
		const onExported = ({ buffer }: { buffer: ArrayBuffer }) => {
			downloaded.push(buffer);
		};

		const first = project.export({ options: OPTIONS, onExported });
		await flush();
		exports[0].finish({ success: true, buffer: new ArrayBuffer(8) });
		// The second export starts after the first one's renderer finished but
		// before the first resumes to publish its result.
		const replacements: Promise<ExportResult>[] = [];
		queueMicrotask(() => {
			replacements.push(project.export({ options: OPTIONS, onExported }));
		});

		expect(await first).toEqual({ success: false, cancelled: true });
		expect(downloaded).toHaveLength(0);
		expect(project.getExportState()).toEqual({
			isExporting: true,
			progress: 0,
			result: null,
		});

		await flush();
		expect(exports).toHaveLength(2);
		const buffer = new ArrayBuffer(16);
		exports[1].finish({ success: true, buffer });
		expect(await replacements[0]).toEqual({ success: true, buffer });
		expect(downloaded).toEqual([buffer]);
		expect(project.getExportState()).toMatchObject({
			isExporting: false,
			result: { success: true },
		});
	});

	test("an export a subscriber replaces while it publishes leaves the download to the replacement", async () => {
		const { project, exports } = setup();
		const downloaded: ArrayBuffer[] = [];
		const onExported = ({ buffer }: { buffer: ArrayBuffer }) => {
			downloaded.push(buffer);
		};
		// A subscriber that starts another export as soon as one finishes.
		const replacements: Promise<ExportResult>[] = [];
		project.subscribe(() => {
			const { result } = project.getExportState();
			if (result?.success && replacements.length === 0) {
				replacements.push(project.export({ options: OPTIONS, onExported }));
			}
		});

		const first = project.export({ options: OPTIONS, onExported });
		await flush();
		exports[0].finish({ success: true, buffer: new ArrayBuffer(8) });

		expect(await first).toEqual({ success: false, cancelled: true });
		expect(replacements).toHaveLength(1);
		expect(downloaded).toHaveLength(0);
		expect(project.getExportState()).toEqual({
			isExporting: true,
			progress: 0,
			result: null,
		});

		await flush();
		expect(exports).toHaveLength(2);
		const buffer = new ArrayBuffer(16);
		exports[1].finish({ success: true, buffer });
		expect(await replacements[0]).toEqual({ success: true, buffer });
		expect(downloaded).toEqual([buffer]);
	});

	test("a subscriber that cancels when an export starts cancels that export", async () => {
		const { project, exports } = setup();
		const downloaded: ArrayBuffer[] = [];
		let cancelled = false;
		project.subscribe(() => {
			if (project.getExportState().isExporting && !cancelled) {
				cancelled = true;
				project.cancelExport();
			}
		});

		const started = project.export({
			options: OPTIONS,
			onExported: ({ buffer }) => downloaded.push(buffer),
		});
		await flush();
		expect(exports).toHaveLength(1);
		expect(exports[0].signal.aborted).toBe(true);

		exports[0].finish({ success: false, cancelled: true });
		expect(await started).toEqual({ success: false, cancelled: true });
		expect(downloaded).toHaveLength(0);
	});

	test("cancelling one export leaves the next one's signal alone", async () => {
		const { project, exports } = setup();

		const first = project.export({ options: OPTIONS });
		await flush();
		project.cancelExport();
		exports[0].finish({ success: false, cancelled: true });
		await first;

		const second = project.export({ options: OPTIONS });
		await flush();
		expect(exports[1].signal.aborted).toBe(false);
		exports[1].finish({ success: true, buffer: new ArrayBuffer(8) });
		expect(await second).toMatchObject({ success: true });
	});
});
