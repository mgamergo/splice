import { beforeEach, describe, expect, test } from "bun:test";
import { EditorApi } from "@/agent/editor-api";
import { CAPTION_TRACK_NAME, placeShortCaptions } from "@/agent/short-captions";
import { isHookTrack } from "@/agent/short-hook";
import { fillExplainerPicture } from "@/agent/explainer-picture";
import { setUpEditor, s, videoClip } from "@/agent/__tests__/fixtures";
import { findGraphicClip, summarizeGraphics } from "@/agent/graphics";
import { UpdateClipsCommand } from "@/commands/timeline/clip/update-clips";
import type { EditorCore } from "@/core";
import { projectShortStyle } from "@/project/format";
import { buildScene } from "@/services/renderer/scene-builder";
import { TextNode } from "@/services/renderer/nodes/text-node";

const canvas = { width: 1080, height: 1920 };
const recording = {
	id: "rec",
	name: "Vertical recording",
	type: "video" as const,
	duration: 6,
	...canvas,
	hasAudio: true,
	file: new File([], "recording.mp4"),
};
const sources = [
	{
		projectItemId: "rec",
		words: [
			{ start: 0.2, end: 0.5, text: "Open settings." },
			{ start: 0.85, end: 1.35, text: "Pick a device." },
			{ start: 3, end: 3.5, text: "Save." },
		],
	},
];
const highlight = {
	kind: "highlight",
	projectItemId: "rec",
	passage: { start: 0.85, end: 1.35 },
	target: { x: 0.42, y: 0.46, width: 0.12, height: 0.08 },
};
const card = {
	kind: "card",
	projectItemId: "rec",
	passage: { start: 0.85, end: 1.35 },
	title: "One device",
	text: "Changes apply to the selected device.",
};
const opening = {
	text: "Choose one device",
	demonstrationStart: 0.8,
	evidence: {
		kind: "narration",
		projectItemId: "rec",
		time: 0.2,
		detail: "Open settings",
	},
};
let editor: EditorCore;
let api: EditorApi;

const sequence = () => editor.sequences.getActiveSequence();
const revision = () => ({ expectedRevision: api.getRevision() });
const captionTrack = () => {
	const track = sequence().tracks.overlay.find(
		(track) => track.type === "text" && track.name === CAPTION_TRACK_NAME,
	);
	if (!track || track.type !== "text")
		throw new Error("Captions track missing");
	return track;
};
const captionYs = () =>
	captionTrack().clips.map((clip) =>
		Number(clip.params["transform.positionY"]),
	);
const addCaptions = () => api.addCaptions({ ...revision(), sources });
const setRaw = () => api.setShortStyle({ ...revision(), style: "raw" });
const applyGraphics = (graphics: object[]) =>
	api.graphicsApply({ ...revision(), graphics });

beforeEach(() => {
	editor = setUpEditor({ tracks: {} });
	const project = editor.project.getActive();
	editor.project.setActiveProject({
		project: {
			...project,
			settings: { ...project.settings, format: "short", canvasSize: canvas },
		},
	});
	editor.media.setProjectItems({ projectItems: [recording] });
	editor.timeline.updateTracks({
		...sequence().tracks,
		main: {
			...sequence().tracks.main,
			clips: [videoClip({ id: "picture", start: 0, duration: 6 })],
		},
	});
	api = new EditorApi(editor);
});

describe("Short styles", () => {
	test("defaults old projects to Explainer and applies Raw placement as an undoable project setting", () => {
		expect(projectShortStyle({ project: editor.project.getActive() })).toBe(
			"explainer",
		);
		expect(addCaptions()).toMatchObject({ ok: true });
		expect(captionYs()).toEqual([0, 0, 0]);
		expect(
			api.setShortStyle({ expectedRevision: 0, style: "raw" }),
		).toMatchObject({ code: "REVISION_CONFLICT" });
		expect(setRaw()).toMatchObject({ ok: true, style: "raw" });
		expect(editor.project.getActive().settings.shortStyle).toBe("raw");
		expect(captionYs().every((y) => y > 300)).toBe(true);
		editor.command.undo();
		expect(captionYs()).toEqual([0, 0, 0]);
		editor.command.redo();
		expect(captionYs().every((y) => y > 300)).toBe(true);
	});

	test("keeps a passage clear of a highlight and preserves direct placement and text across reruns", () => {
		addCaptions();
		expect(applyGraphics([highlight])).toMatchObject({ ok: true });
		const moved = captionYs();
		expect(moved[0]).toBeGreaterThan(300);
		expect(moved[1]).toBe(moved[0]);
		expect(moved[2]).toBe(0);
		const track = captionTrack();
		const [clip] = track.clips;
		editor.command.execute({
			command: new UpdateClipsCommand({
				updates: [
					{
						trackId: track.id,
						clipId: clip.id,
						patch: {
							params: {
								...clip.params,
								"transform.positionX": 80,
								"transform.positionY": -260,
								content: "Open Settings.",
							},
						},
					},
				],
			}),
		});
		expect(addCaptions()).toMatchObject({ ok: true });
		expect(captionTrack().clips[0].params).toMatchObject({
			"transform.positionX": 80,
			"transform.positionY": -260,
			content: "Open Settings.",
		});
		expect(api.shortCaptionSrt()).toMatchObject({
			srt: expect.stringContaining(
				"00:00:00,200 --> 00:00:00,800\nOpen Settings.",
			),
		});
	});

	test("uses the available clearance below a tall caption when the usual placements overlap", () => {
		addCaptions();
		const tracks = placeShortCaptions({
			tracks: sequence().tracks,
			canvas,
			style: "explainer",
			regions: [
				{
					center: { x: 0, y: 0 },
					width: 200,
					height: 300,
					start: 0.85,
					end: 1.35,
				},
				{
					center: { x: 0, y: 350 },
					width: 200,
					height: 140,
					start: 0.85,
					end: 1.35,
				},
				{
					center: { x: 0, y: -350 },
					width: 200,
					height: 140,
					start: 0.85,
					end: 1.35,
				},
			],
		});
		const track = tracks.overlay.find(
			({ name }) => name === CAPTION_TRACK_NAME,
		);
		expect(
			Number(track?.clips[1].params["transform.positionY"]),
		).toBeGreaterThan(530);
	});

	test("keeps a fixed caption placement across reruns until changed back to Auto", () => {
		addCaptions();
		expect(
			api.setShortCaptionPlacement({ ...revision(), position: "top" }),
		).toMatchObject({ ok: true });
		setRaw();
		addCaptions();
		expect(captionYs().every((y) => y < -300)).toBe(true);
		api.setShortCaptionPlacement({ ...revision(), position: "auto" });
		expect(captionYs().every((y) => y > 300)).toBe(true);
	});

	test("keeps the top half by default and moves a conflicting Explainer card below the action", () => {
		const target = { x: 0.42, y: 0.22, width: 0.12, height: 0.06 };
		const cardY = () => {
			const graphic = summarizeGraphics({ sequence: sequence() }).find(
				({ kind }) => kind === "card",
			);
			return (
				graphic &&
				Number(
					findGraphicClip({ tracks: sequence().tracks, graphicId: graphic.id })
						?.clip.params["transform.positionY"],
				)
			);
		};
		applyGraphics([card]);
		expect(cardY()).toBeLessThan(0);
		applyGraphics([card, { ...highlight, target }]);
		expect(cardY()).toBeGreaterThan(0);
	});

	test("requires creator direction for Raw cards and still allows a highlight", () => {
		setRaw();
		expect(api.graphicsPlan({ graphics: [card] })).toMatchObject({
			graphics: [{ status: "skip_needs_direction" }],
		});
		applyGraphics([card, highlight]);
		expect(
			summarizeGraphics({ sequence: sequence() }).map(({ kind }) => kind),
		).toEqual(["highlight"]);
		applyGraphics([{ ...card, creatorDirected: true }]);
		expect(
			summarizeGraphics({ sequence: sequence() }).map(({ kind }) => kind),
		).toEqual(["highlight", "card"]);
	});

	test("hides Explainer cards in Raw unless the creator directed them, and restores them on return", () => {
		applyGraphics([card]);
		const [initial] = summarizeGraphics({ sequence: sequence() });
		setRaw();
		const [raw] = summarizeGraphics({ sequence: sequence() });
		expect(raw).toMatchObject({ id: initial.id, status: "hidden" });
		api.setShortStyle({ ...revision(), style: "explainer" });
		const [explainer] = summarizeGraphics({ sequence: sequence() });
		expect(explainer).toMatchObject({ id: initial.id, status: "shown" });
	});

	test("skips repeating the opening words and renders an evidence-linked hook only before the demonstration", () => {
		addCaptions();
		setRaw();
		expect(
			api.setShortHook({
				...revision(),
				hook: { ...opening, text: "Open settings." },
			}),
		).toMatchObject({ status: "skipped_redundant" });
		expect(
			api.setShortHook({
				...revision(),
				hook: { ...opening, evidence: { ...opening.evidence, time: 4 } },
			}),
		).toMatchObject({ ok: false });
		expect(api.setShortHook({ ...revision(), hook: opening })).toMatchObject({
			status: "placed",
		});
		const [hook] = sequence().tracks.overlay.filter(isHookTrack);
		expect(hook.clips[0]).toMatchObject({ startTime: s(0), duration: s(0.8) });
		const scene = buildScene({
			tracks: sequence().tracks,
			projectItems: [recording],
			duration: s(6),
			canvasSize: canvas,
			background: { type: "color", color: "#000000" },
		});
		expect(
			scene.children.some(
				(node) =>
					node instanceof TextNode && node.params.name === "Opening hook",
			),
		).toBe(true);
		api.setShortStyle({ ...revision(), style: "explainer" });
		expect(sequence().tracks.overlay.find(isHookTrack)?.hidden).toBe(true);
		setRaw();
		expect(sequence().tracks.overlay.find(isHookTrack)?.hidden).toBe(false);
		expect(api.setShortHook({ ...revision(), hook: null })).toMatchObject({
			status: "removed",
		});
		expect(sequence().tracks.overlay.find(isHookTrack)).toBeUndefined();
	});

	test("fills the frame for default vertical footage and preserves manually framed footage", () => {
		const { tracks } = sequence();
		const [clip] = tracks.main.clips;
		const items = [{ ...recording, width: 1080, height: 1440 }];
		expect(
			fillExplainerPicture({ tracks, canvas, projectItems: items }).main
				.clips[0].params,
		).toMatchObject({
			"transform.scaleX": 4 / 3,
			"transform.scaleY": 4 / 3,
		});
		const manual = {
			...clip,
			params: { ...clip.params, "transform.positionX": 100 },
		};
		expect(
			fillExplainerPicture({
				tracks: { ...tracks, main: { ...tracks.main, clips: [manual] } },
				canvas,
				projectItems: items,
			}).main.clips[0],
		).toBe(manual);
	});

	test("captures the Short MP4 and optional SRT from the same tracks before rendering", async () => {
		addCaptions();
		const captured = sequence().tracks;
		const initialSrt = api.shortCaptionSrt();
		const file = new ArrayBuffer(1);
		editor.renderer.exportProject = async ({ scene, options }) => {
			expect(scene?.tracks).toBe(captured);
			expect(scene?.canvasSize).toEqual(canvas);
			expect(options).toMatchObject({ format: "mp4", includeAudio: true });
			return { success: true, buffer: file };
		};
		const deliveries: Array<{ buffer: ArrayBuffer; srt?: string }> = [];
		const options = { format: "webm", quality: "high" } as const;
		await editor.project.export({
			options,
			onExported: (files) => deliveries.push(files),
		});
		const result = editor.project.export({
			options,
			includeSrt: true,
			onExported: (files) => deliveries.push(files),
		});
		addCaptions();
		await result;
		expect(deliveries).toEqual([
			{ buffer: file },
			{ buffer: file, ...("srt" in initialSrt && { srt: initialSrt.srt }) },
		]);
	});
});
