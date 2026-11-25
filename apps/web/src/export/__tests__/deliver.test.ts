import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { type ExportRecord, exportRecordSchema } from "@splice/bridge/delivery";
import { setUpEditor, videoClip } from "@/agent/__tests__/fixtures";
import { setCaptionSources } from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import type { EditorCore } from "@/core";
import type { ExportScene } from "@/core/managers/renderer-manager";
import type { ExportOptions, ExportResult } from "@/export";
import { deliveryFingerprint, takeDeliverySnapshot } from "@/export/deliver";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import { buildDefaultSequence } from "@/timeline/sequences";

const initialCaptionsState = useCaptionsStore.getState();
const globals = globalThis as { window?: unknown };
const hadWindow = "window" in globals;
const originalWindow = globals.window;

/**
 * A `splice` that publishes each Export click's pair once, and can lose its
 * answer to a publish that went through.
 */
function fakeSplice() {
	const published: ExportRecord[] = [];
	const begun = new Map<string, { deliveryId: string; source: object }>();
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	let loseNextPublishAnswer = false;
	const respond = (result: unknown) =>
		new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
	// fetch's own signature, so positional.
	const fakeFetch = async (...[input, init]: Parameters<typeof fetch>) => {
		const url = String(input);
		if (init?.method === "PUT") return respond({ bytes: 1 });
		const { method, params } = JSON.parse(String(init?.body));
		calls.push({ method, params });
		if (method === "exports.begin") {
			const committed = published.find(
				({ deliveryId }) => deliveryId === params.deliveryId,
			);
			if (committed) return respond({ committed });
			const exportId = crypto.randomUUID();
			const { deliveryId, ...source } = params;
			begun.set(exportId, { deliveryId, source });
			return respond({ exportId });
		}
		if (method === "exports.publish") {
			const entry = begun.get(params.exportId);
			if (!entry) throw new Error(`Unknown export at ${url}`);
			begun.delete(params.exportId);
			const record = exportRecordSchema.parse({
				...entry.source,
				deliveryId: entry.deliveryId,
				stem: `Test ${published.length + 1}`,
				exportedAt: new Date(0).toISOString(),
				bytes: { mp4: 8, srt: 1 },
			});
			published.push(record);
			if (loseNextPublishAnswer) {
				loseNextPublishAnswer = false;
				throw new TypeError("Failed to fetch");
			}
			return respond(record);
		}
		return respond({ aborted: true });
	};
	return {
		published,
		calls,
		loseNextPublishAnswer: () => {
			loseNextPublishAnswer = true;
		},
		fetch: Object.assign(fakeFetch, { preconnect: globalThis.fetch.preconnect }),
	};
}

/** A Horizontal project at 60 fps (as importing 60 fps media leaves it) with captions. */
function horizontalEditor(): EditorCore {
	const { main } = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	const editor = setUpEditor({
		tracks: { main: { ...main, clips: [videoClip({ id: "a", start: 0, duration: 10 })] } },
	});
	const project = editor.project.getActive();
	editor.project.setActiveProject({
		project: {
			...project,
			settings: {
				...project.settings,
				fps: { numerator: 60, denominator: 1 },
				canvasSize: { width: 1280, height: 720 },
			},
		},
	});
	setCaptionSources({
		editor,
		sources: [
			{
				projectItemId: "rec",
				words: [
					{ start: 1, end: 1.3, text: "Deploy" },
					{ start: 1.35, end: 1.6, text: "to" },
					{ start: 1.65, end: 2, text: "versel." },
				],
			},
		],
	});
	return editor;
}

/** Each render the fake renderer was asked for, finished at once. */
function recordRenders(editor: EditorCore) {
	const renders: Array<{ options: ExportOptions; scene?: ExportScene }> = [];
	editor.renderer.exportProject = async ({ options, scene }) => {
		renders.push({ options, scene });
		return { success: true, buffer: new ArrayBuffer(8) } satisfies ExportResult;
	};
	return renders;
}

let splice: ReturnType<typeof fakeSplice>;

beforeEach(() => {
	globals.window = { localStorage: { getItem: () => "token" } };
	splice = fakeSplice();
	spyOn(globalThis, "fetch").mockImplementation(splice.fetch);
});

afterEach(() => {
	mock.restore();
	useCaptionsStore.setState(initialCaptionsState, true);
	if (hadWindow) globals.window = originalWindow;
	else delete globals.window;
});

describe("Horizontal delivery", () => {
	test("applies spellings to the approved edit while newer edits are made", async () => {
		const editor = horizontalEditor();
		const renders = recordRenders(editor);
		const approved = takeDeliverySnapshot({ editor });
		let release: () => void = () => {};
		const loadSpellings = mock(
			() =>
				new Promise<Array<{ from: string; to: string }>>((resolve) => {
					release = () => {
						const spellings = [{ from: "versel", to: "Vercel" }];
						useCaptionsStore.setState({ spellings, spellingsLoaded: true });
						resolve(spellings);
					};
				}),
		);
		useCaptionsStore.setState({ loadSpellings });

		const exported = editor.project.deliver({ quality: "high" });
		expect(editor.project.getExportState().step).toBe("spellings");
		while (!loadSpellings.mock.calls.length)
			await new Promise((resolve) => setTimeout(resolve, 0));
		// Nothing renders until the spellings are in.
		expect(renders).toHaveLength(0);
		setCaptionSources({ editor, sources: [] });
		const { tracks } = editor.sequences.getActiveSequence();
		editor.sequences.updateSequenceTracks({
			tracks: { ...tracks, main: { ...tracks.main, clips: [] } },
		});
		expect(editor.command.getRevision()).toBeGreaterThan(approved.source.revision);
		release();
		const result = await exported;
		expect(result).toMatchObject({ success: true, record: { ...approved.source } });
		expect(renders[0].scene).toEqual(approved.scene);
		expect(loadSpellings).toHaveBeenCalled();
		const begin = splice.calls.find(({ method }) => method === "exports.begin");
		// The fingerprint covers the SRT with the spelling applied.
		expect(begin?.params.fingerprint).toBe(
			await deliveryFingerprint({
				...approved,
				srt: approved.srt.replace("versel", "Vercel"),
			}),
		);
	});

	test("Retry after a spellings load failure still exports the approved revision", async () => {
		const editor = horizontalEditor();
		const renders = recordRenders(editor);
		const approved = takeDeliverySnapshot({ editor });
		let attempts = 0;
		useCaptionsStore.setState({
			loadSpellings: async () => {
				attempts++;
				if (attempts === 1) throw new Error("splice is not running");
				return [];
			},
		});
		expect(await editor.project.deliver({ quality: "high" })).toMatchObject({
			success: false,
			failedStep: "spellings",
			error: expect.stringContaining("splice is not running"),
		});
		setCaptionSources({ editor, sources: [] });
		expect(await editor.project.retryDelivery()).toMatchObject({
			success: true,
			record: { ...approved.source, fingerprint: await deliveryFingerprint(approved) },
		});
		expect(attempts).toBe(2);
		expect(renders).toHaveLength(1);
	});

	test("renders 1920×1080 at 30 fps, and Retry renders the approved edit, not a later one", async () => {
		const editor = horizontalEditor();
		useCaptionsStore.setState({ spellingsLoaded: true });
		const sequenceId = editor.sequences.getActiveSequence().id;
		const setGain = (gainDb: number) => {
			editor.command.execute({ command: new UpdateSequenceCommand({
				editor,
				sequenceId,
				label: "Adjust mix",
				updates: { mix: { loudness: {
					gainDb,
					targetLufs: -14,
					ceilingDbtp: -1,
					measuredLufs: -17,
					measuredTruePeakDbtp: -5,
					expectedLufs: -14,
					expectedTruePeakDbtp: -2,
					fingerprint: "mix",
				} } },
			}) });
		};
		setGain(3);
		const approved = takeDeliverySnapshot({ editor });
		setGain(2);
		expect(await deliveryFingerprint(takeDeliverySnapshot({ editor })))
			.not.toBe(await deliveryFingerprint(approved));
		setGain(3);

		const renders = recordRenders(editor);
		// The first render fails, so Retry renders again.
		let failRender = true;
		const render = editor.renderer.exportProject;
		editor.renderer.exportProject = async (args) => {
			if (failRender) {
				failRender = false;
				await render(args);
				return { success: false, error: "GPU lost" };
			}
			return render(args);
		};

		expect(await editor.project.deliver({ quality: "high" })).toMatchObject({
			success: false,
			failedStep: "render",
		});
		// The creator keeps editing before retrying.
		setGain(6);
		const project = editor.project.getActive();
		editor.project.setActiveProject({
			project: {
				...project,
				settings: {
					...project.settings,
					fps: { numerator: 24, denominator: 1 },
					background: { type: "color", color: "#ff0000" },
				},
			},
		});
		const { tracks } = editor.sequences.getActiveSequence();
		editor.sequences.updateSequenceTracks({
			tracks: { ...tracks, main: { ...tracks.main, clips: [] } },
		});

		const retried = await editor.project.retryDelivery();
		expect(retried).toMatchObject({ success: true });
		expect(renders).toHaveLength(2);
		for (const { options, scene } of renders) {
			expect(options.fps).toEqual({ numerator: 30, denominator: 1 });
			expect(scene?.master).toEqual({ gainDb: 3, ceilingDbtp: -1 });
			expect(scene?.canvasSize).toEqual({ width: 1920, height: 1080 });
			expect(scene?.background).toEqual({ type: "color", color: "#000000" });
			expect(scene?.tracks.main.clips.map(({ id }) => id)).toEqual(["a"]);
		}
		expect(renders[1].scene).toBe(renders[0].scene);
	});

	test("Retry after a lost publish answer returns the published pair instead of a second one", async () => {
		const editor = horizontalEditor();
		useCaptionsStore.setState({ spellingsLoaded: true });
		recordRenders(editor);
		splice.loseNextPublishAnswer();

		expect(await editor.project.deliver({ quality: "high" })).toMatchObject({
			success: false,
			failedStep: "publish",
		});
		expect(splice.published).toHaveLength(1);

		const retried = await editor.project.retryDelivery();
		expect(retried).toMatchObject({
			success: true,
			record: { stem: splice.published[0].stem },
		});
		expect(splice.published).toHaveLength(1);
		const begins = splice.calls.filter(({ method }) => method === "exports.begin");
		expect(begins).toHaveLength(2);
		expect(begins[1].params.deliveryId).toBe(begins[0].params.deliveryId);
		// The pair was published, so nothing more went up.
		expect(splice.calls.filter(({ method }) => method === "exports.publish")).toHaveLength(1);
	});
});
