import { GRAPHIC_PROPERTIES } from "@splice/bridge/graphics";
import type {
	GraphicFlag,
	GraphicKind,
	GraphicOverrides,
	GraphicProperty,
	GraphicRecord,
	GraphicTombstone,
	GraphicValues,
	PlannedGraphic,
	SequenceGraphics,
	TargetRect,
} from "@splice/bridge/graphics";
import { isLeafChannelData } from "@/animation/channel-data";
import { isScalarChannel } from "@/animation/interpolation";
import type { ScalarAnimationKey } from "@/animation/types";
import { playedClips } from "@/agent/rough-cut";
import { highlightBoxSize } from "@/graphics/definitions/graphics-pass";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics/types";
import type { ProjectItem } from "@/media/types";
import { buildTransformFromParams } from "@/rendering";
import { resolveTransformAtTime } from "@/rendering/animation-values";
import { buildGraphicClip, buildTextClip } from "@/timeline/clip-utils";
import { buildEmptyTrack } from "@/timeline/placement";
import type {
	GraphicClip,
	OverlayTrack,
	SequenceTracks,
	TextClip,
	TimelineClip,
	TSequence,
	VideoClip,
	VideoTrack,
} from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import {
	type MediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
} from "@/wasm";

/** The overlay tracks highlights and zoom handles go on, and the one cards go on. */
export const GRAPHICS_TRACK_NAME = "Graphics";
export const CARDS_TRACK_NAME = "Cards";

const ZOOM_RAMP_SECONDS = 0.4;
const DEFAULT_MAX_ZOOM = 2.5;
/** A zoom smaller than this doesn't make the target more legible; the shot stays wide. */
const MIN_USEFUL_ZOOM = 1.2;
/** How much of the screen a zoomed target fills, at most. */
const ZOOM_FILL = 0.7;
/** Canvas pixels between a target and its highlight box, and the box's line. */
const HIGHLIGHT_PADDING = 12;
const HIGHLIGHT_STROKE = 5;
/** Actions this close in one recording are the same action. */
const SAME_ACTION_SECONDS = 1 / 30;
const MIN_GRAPHIC_SECONDS = 0.3;
/** A passage that keeps less of its narration than this is flagged. */
const MIN_PASSAGE_COVERAGE = 0.9;
const TIME_EPSILON = 1 / 240;
const POSITION_EPSILON = 0.5;
const SCALE_EPSILON = 1e-3;
const CARD_LINE_LENGTH = 42;
const CARD_FONT_SIZE = 3.2;

const ZOOM_CHANNELS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
] as const;

export interface CanvasSize {
	width: number;
	height: number;
}

interface Point {
	x: number;
	y: number;
}

/** A rectangle on the canvas, in pixels from the canvas center. */
interface CanvasRect {
	center: Point;
	width: number;
	height: number;
}

/** A zoom's view: the canvas point it centers and how much it magnifies. */
interface ZoomView {
	center: Point;
	scale: number;
}

type ProjectItemSizes = Map<string, { width?: number; height?: number }>;

const seconds = (time: MediaTime) => mediaTimeToSeconds({ time });
const ticks = (value: number) => mediaTimeFromSeconds({ seconds: value });

function numberParam({
	clip,
	key,
	fallback,
}: {
	clip: TimelineClip;
	key: string;
	fallback: number;
}) {
	const value = clip.params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function itemSizes(projectItems: ProjectItem[]): ProjectItemSizes {
	return new Map(
		projectItems.map(({ id, width, height }) => [id, { width, height }]),
	);
}

/** Where a recording's picture sits on the canvas. Omit time for its base framing. */
function screenFrame({
	clip,
	size,
	canvas,
	time,
}: {
	clip: VideoClip;
	size?: { width?: number; height?: number };
	canvas: CanvasSize;
	time?: number;
}): CanvasRect {
	const sourceWidth = size?.width || canvas.width;
	const sourceHeight = size?.height || canvas.height;
	const contain = Math.min(
		canvas.width / sourceWidth,
		canvas.height / sourceHeight,
	);
	const baseTransform = buildTransformFromParams({ params: clip.params });
	const transform =
		time === undefined
			? baseTransform
			: resolveTransformAtTime({
					baseTransform,
					animations: clip.animations,
					localTime: time - seconds(clip.startTime),
				});
	return {
		center: transform.position,
		width: sourceWidth * contain * transform.scaleX,
		height: sourceHeight * contain * transform.scaleY,
	};
}

function targetOnCanvas({
	frame,
	target,
}: {
	frame: CanvasRect;
	target: TargetRect;
}): CanvasRect {
	return {
		center: {
			x: frame.center.x + (target.x + target.width / 2 - 0.5) * frame.width,
			y: frame.center.y + (target.y + target.height / 2 - 0.5) * frame.height,
		},
		width: target.width * frame.width,
		height: target.height * frame.height,
	};
}

const clampToRange = ({
	value,
	low,
	high,
}: {
	value: number;
	low: number;
	high: number;
}) => (low > high ? (low + high) / 2 : Math.min(high, Math.max(low, value)));

/**
 * The view that makes a target legible: magnified until it fills ZOOM_FILL of
 * the screen, centered on it, and kept inside the recording's picture. Null
 * when no zoom up to `maxZoom` would help.
 */
export function planZoomView({
	frame,
	target,
	canvas,
	maxZoom = DEFAULT_MAX_ZOOM,
}: {
	frame: CanvasRect;
	target: CanvasRect;
	canvas: CanvasSize;
	maxZoom?: number;
}): ZoomView | null {
	const scale = Math.min(
		maxZoom,
		(ZOOM_FILL * canvas.width) / target.width,
		(ZOOM_FILL * canvas.height) / target.height,
	);
	if (scale < MIN_USEFUL_ZOOM) return null;
	const halfView = {
		x: canvas.width / (2 * scale),
		y: canvas.height / (2 * scale),
	};
	return {
		scale,
		center: {
			x: clampToRange({
				value: target.center.x,
				low: frame.center.x - frame.width / 2 + halfView.x,
				high: frame.center.x + frame.width / 2 - halfView.x,
			}),
			y: clampToRange({
				value: target.center.y,
				low: frame.center.y - frame.height / 2 + halfView.y,
				high: frame.center.y + frame.height / 2 - halfView.y,
			}),
		},
	};
}

/** The side of a zoom handle's square source that fits the canvas. */
const handleSide = (canvas: CanvasSize) =>
	Math.min(canvas.width, canvas.height);

function zoomHandleScale({
	view,
	canvas,
}: {
	view: ZoomView;
	canvas: CanvasSize;
}) {
	const side = handleSide(canvas);
	return {
		scaleX: canvas.width / (view.scale * side),
		scaleY: canvas.height / (view.scale * side),
	};
}

/** A zoom handle's size on the canvas says how much it magnifies. */
function zoomScaleFromHandle({
	clip,
	canvas,
}: {
	clip: TimelineClip;
	canvas: CanvasSize;
}): number {
	const side = handleSide(canvas);
	const area =
		Math.abs(
			numberParam({ clip: clip, key: "transform.scaleX", fallback: 1 }),
		) *
		Math.abs(
			numberParam({ clip: clip, key: "transform.scaleY", fallback: 1 }),
		) *
		side *
		side;
	return Math.sqrt((canvas.width * canvas.height) / Math.max(area, 1e-6));
}

// ---------------------------------------------------------------------------
// Finding actions on the sequence

interface Anchor {
	/** Sequence seconds. */
	time: number;
	trackId: string;
	clip: VideoClip;
}

function videoTracks(tracks: SequenceTracks): VideoTrack[] {
	return [
		...tracks.overlay.filter(
			(track): track is VideoTrack => track.type === "video",
		),
		tracks.main,
	];
}

function sourceRange(clip: TimelineClip) {
	const rate = ("retime" in clip && clip.retime?.rate) || 1;
	const start = seconds(clip.trimStart);
	return { start, end: start + seconds(clip.duration) * rate, rate };
}

/**
 * Where a recording's source second shows on the sequence: the visible
 * picture clips that play it, the one nearest `near` when it plays twice.
 */
export function locateSourceTime({
	tracks,
	projectItemId,
	sourceTime,
	near,
}: {
	tracks: SequenceTracks;
	projectItemId: string;
	sourceTime: number;
	near?: number;
}): Anchor | null {
	const found: Anchor[] = [];
	for (const track of videoTracks(tracks)) {
		if (track.hidden) continue;
		for (const clip of track.clips) {
			if (
				clip.type !== "video" ||
				clip.mediaId !== projectItemId ||
				clip.hidden
			)
				continue;
			const range = sourceRange(clip);
			if (sourceTime < range.start || sourceTime >= range.end) continue;
			found.push({
				time: seconds(clip.startTime) + (sourceTime - range.start) / range.rate,
				trackId: track.id,
				clip,
			});
		}
	}
	if (found.length === 0) return null;
	const distance = (anchor: Anchor) =>
		near === undefined ? anchor.time : Math.abs(anchor.time - near);
	return found.reduce((best, anchor) =>
		distance(anchor) < distance(best) ? anchor : best,
	);
}

/** How much of a source passage still plays somewhere on the sequence, 0–1. */
export function passageCoverage({
	tracks,
	passage,
	projectItems,
}: {
	tracks: SequenceTracks;
	passage: GraphicRecord["passage"];
	projectItems: ProjectItem[];
}): number {
	const ranges: Array<[number, number]> = [];
	for (const { clip } of playedClips({ tracks, projectItems })) {
		if (clip.mediaId !== passage.projectItemId) continue;
		const range = sourceRange(clip);
		const start = Math.max(range.start, passage.start);
		const end = Math.min(range.end, passage.end);
		if (end > start) ranges.push([start, end]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	let covered = 0;
	let reach = passage.start;
	for (const [start, end] of ranges) {
		if (end <= reach) continue;
		covered += end - Math.max(start, reach);
		reach = end;
	}
	return covered / Math.max(passage.end - passage.start, 1e-9);
}

/** A fingerprint of the picture clips, so a cut can be told from a graphic adjustment. */
export function screenSignature(tracks: SequenceTracks): string {
	let hash = 0x811c9dc5;
	for (const track of videoTracks(tracks)) {
		for (const clip of track.clips) {
			const text = `${track.id}|${clip.id}|${clip.startTime}|${clip.duration}|${clip.trimStart}|${"mediaId" in clip ? clip.mediaId : ""}|${clip.hidden ? 1 : 0}|${track.hidden ? 1 : 0}|${sourceRange(clip).rate};`;
			for (let index = 0; index < text.length; index++) {
				hash ^= text.charCodeAt(index);
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
		}
	}
	return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Graphic clips

const trackKind = (kind: GraphicKind) => (kind === "card" ? "text" : "graphic");

function wrapCardText(text: string): string {
	return text
		.split("\n")
		.flatMap((paragraph) => {
			const lines: string[] = [];
			let line = "";
			for (const word of paragraph
				.split(/\s+/)
				.flatMap((word) => word.match(/.{1,42}/gu) ?? [])) {
				if (line && line.length + word.length + 1 > CARD_LINE_LENGTH) {
					lines.push(line);
					line = word;
				} else line = line ? `${line} ${word}` : word;
			}
			return [...lines, line];
		})
		.join("\n");
}

export function cardText({ title, text }: { title?: string; text?: string }) {
	return [title && wrapCardText(title), text && wrapCardText(text)]
		.filter(Boolean)
		.join("\n");
}

/** The values a graphic clip shows now, read back to spot the creator's changes. */
function readGraphicClip({
	clip,
	kind,
	canvas,
}: {
	clip: TimelineClip;
	kind: GraphicKind;
	canvas: CanvasSize;
}) {
	return {
		start: seconds(clip.startTime),
		duration: seconds(clip.duration),
		position: {
			x: numberParam({ clip: clip, key: "transform.positionX", fallback: 0 }),
			y: numberParam({ clip: clip, key: "transform.positionY", fallback: 0 }),
		},
		scale:
			kind === "zoom"
				? zoomScaleFromHandle({ clip, canvas })
				: numberParam({ clip: clip, key: "transform.scaleX", fallback: 1 }),
		scaleY:
			kind !== "zoom"
				? numberParam({ clip, key: "transform.scaleY", fallback: 1 })
				: undefined,
		text: kind === "card" ? String(clip.params.content ?? "") : undefined,
		hidden: "hidden" in clip && !!clip.hidden,
	};
}

function graphicClipParams({
	record,
	values,
	canvas,
	sizes,
}: {
	record: GraphicRecord;
	values: GraphicValues;
	canvas: CanvasSize;
	sizes: ProjectItemSizes;
}): Record<string, number | string> {
	const position = values.position ?? { x: 0, y: 0 };
	const params: Record<string, number | string> = {
		"transform.positionX": position.x,
		"transform.positionY": position.y,
	};
	const scale = values.scale ?? 1;
	if (record.kind === "zoom") {
		const { scaleX, scaleY } = zoomHandleScale({
			view: { center: position, scale },
			canvas,
		});
		params["transform.scaleX"] = scaleX;
		params["transform.scaleY"] = scaleY;
	} else {
		params["transform.scaleX"] = scale;
		params["transform.scaleY"] = values.scaleY ?? scale;
	}
	if (record.kind === "card") params.content = values.text ?? "";
	if (record.kind === "highlight" && record.target) {
		const size = sizes.get(record.action.projectItemId);
		const aspect =
			(record.target.width * (size?.width || canvas.width)) /
			(record.target.height * (size?.height || canvas.height));
		params.aspect = Math.min(20, Math.max(0.05, aspect));
	}
	return params;
}

function newGraphicClip({
	record,
	params,
	start,
	duration,
	canvas,
}: {
	record: GraphicRecord;
	params: Record<string, number | string>;
	start: number;
	duration: number;
	canvas: CanvasSize;
}): GraphicClip | TextClip {
	const startTime = ticks(start);
	const base =
		record.kind === "card"
			? buildTextClip({
					raw: {
						name: "Card",
						params: {
							fontSize: CARD_FONT_SIZE,
							fontWeight: "bold",
							textAlign: "center",
							color: "#ffffff",
							lineHeight: 1.3,
							"background.enabled": true,
							"background.color": "#0f172acc",
							"background.cornerRadius": 30,
							"background.paddingX": 160,
							"background.paddingY": 130,
						},
					},
					startTime,
				})
			: buildGraphicClip({
					definitionId: record.kind,
					name: record.kind === "zoom" ? "Zoom" : "Highlight",
					startTime,
					// The line is drawn on the square source, so it thins as the box grows.
					params:
						record.kind === "highlight"
							? {
									strokeWidth: Math.min(
										64,
										Math.max(
											1,
											(HIGHLIGHT_STROKE * DEFAULT_GRAPHIC_SOURCE_SIZE) /
												(Number(params["transform.scaleX"]) *
													handleSide(canvas)),
										),
									),
								}
							: undefined,
				});
	return {
		...base,
		id: generateUUID(),
		duration: ticks(duration),
		graphicId: record.id,
		params: { ...base.params, ...params },
	} satisfies GraphicClip | TextClip;
}

const overlaps = ({
	clip,
	start,
	end,
}: {
	clip: TimelineClip;
	start: number;
	end: number;
}) =>
	seconds(clip.startTime) < end - TIME_EPSILON &&
	seconds(clip.startTime) + seconds(clip.duration) > start + TIME_EPSILON;

function filterGraphicTracks({
	tracks,
	keep,
}: {
	tracks: SequenceTracks;
	keep: (clip: TimelineClip) => boolean;
}): SequenceTracks {
	return {
		...tracks,
		overlay: tracks.overlay.map((track) => {
			if (track.clips.every(keep)) return track;
			if (track.type === "graphic")
				return { ...track, clips: track.clips.filter(keep) };
			if (track.type === "text")
				return { ...track, clips: track.clips.filter(keep) };
			return track;
		}),
	};
}

function writeGraphicClip({
	track,
	clip,
}: {
	track: OverlayTrack;
	clip: GraphicClip | TextClip;
}): OverlayTrack {
	if (track.type === "graphic" && clip.type === "graphic") {
		return {
			...track,
			clips: track.clips.some(({ id }) => id === clip.id)
				? track.clips.map((existing) =>
						existing.id === clip.id ? clip : existing,
					)
				: [...track.clips, clip],
		};
	}
	if (track.type === "text" && clip.type === "text") {
		return {
			...track,
			clips: track.clips.some(({ id }) => id === clip.id)
				? track.clips.map((existing) =>
						existing.id === clip.id ? clip : existing,
					)
				: [...track.clips, clip],
		};
	}
	return track;
}

/** Puts a graphic on a free track of its type, adding a track if needed. */
function placeClip({
	tracks,
	clip,
}: {
	tracks: SequenceTracks;
	clip: GraphicClip | TextClip;
}): SequenceTracks {
	const start = seconds(clip.startTime);
	const end = start + seconds(clip.duration);
	const name = clip.type === "text" ? CARDS_TRACK_NAME : GRAPHICS_TRACK_NAME;
	const free = tracks.overlay.find(
		(track) =>
			track.type === clip.type &&
			!track.hidden &&
			(track.name.startsWith(name) ||
				track.clips.some((existing) => existing.graphicId)) &&
			!track.clips.some((existing) => overlaps({ clip: existing, start, end })),
	);
	if (free)
		return {
			...tracks,
			overlay: tracks.overlay.map((track) =>
				track === free ? writeGraphicClip({ track, clip }) : track,
			),
		};
	const count = tracks.overlay.filter((track) =>
		track.name.startsWith(name),
	).length;
	const id = generateUUID();
	const trackName = count ? `${name} ${count + 1}` : name;
	const track =
		clip.type === "text"
			? buildEmptyTrack({ id, type: "text", name: trackName })
			: buildEmptyTrack({ id, type: "graphic", name: trackName });
	return {
		...tracks,
		overlay: [writeGraphicClip({ track, clip }), ...tracks.overlay],
	};
}

// ---------------------------------------------------------------------------
// Zoom keyframes on the picture clips

function hasOwnTransformKeys(clip: TimelineClip) {
	return (
		!clip.zoomGraphicIds?.length &&
		ZOOM_CHANNELS.some((path) => clip.animations?.[path])
	);
}

function withoutZoomKeys({
	tracks,
	keepNewKeys,
}: {
	tracks: SequenceTracks;
	keepNewKeys: boolean;
}): SequenceTracks {
	const strip = <TTrack extends VideoTrack>(track: TTrack): TTrack =>
		track.clips.some((clip) => clip.zoomGraphicIds)
			? {
					...track,
					clips: track.clips.map((clip) => {
						if (!clip.zoomGraphicIds) return clip;
						const { zoomGraphicIds: _owned, animations, ...rest } = clip;
						const kept = { ...animations };
						for (const path of ZOOM_CHANNELS) {
							const channel = kept[path];
							if (!channel) continue;
							if (
								keepNewKeys &&
								isLeafChannelData(channel) &&
								isScalarChannel(channel)
							) {
								const keys = channel.keys.filter(
									({ id }) => !id.startsWith("graphics-zoom:"),
								);
								if (keys.length > 0) {
									kept[path] = { keys };
									continue;
								}
							}
							delete kept[path];
						}
						return Object.keys(kept).length
							? { ...rest, animations: kept }
							: rest;
					}),
				}
			: track;
	return {
		...tracks,
		main: strip(tracks.main),
		overlay: tracks.overlay.map((track) =>
			track.type === "video" ? strip(track) : track,
		),
	};
}

interface ZoomPlacement {
	record: GraphicRecord;
	trackId: string;
	start: number;
	end: number;
	view: ZoomView;
}

/** How far into its zoom the picture is at a sequence time, 0–1. */
function zoomAmount({
	zoom: { start, end },
	time,
}: {
	zoom: ZoomPlacement;
	time: number;
}) {
	const ramp = Math.min(ZOOM_RAMP_SECONDS, (end - start) / 3);
	if (time <= start || time >= end) return 0;
	if (time < start + ramp) return (time - start) / ramp;
	if (time > end - ramp) return (end - time) / ramp;
	return 1;
}

/**
 * Adds a zoom's keyframes to every clip on its track that it spans, easing in
 * and out of the view. Returns null when a clip there carries the creator's
 * own position or scale keyframes, which a zoom would fight.
 */
function addZoomKeys({
	tracks,
	zoom,
}: {
	tracks: SequenceTracks;
	zoom: ZoomPlacement;
}): SequenceTracks | null {
	const track = videoTracks(tracks).find(({ id }) => id === zoom.trackId);
	if (!track) return null;
	const spanned = track.clips.filter(
		(clip) =>
			clip.type === "video" &&
			clip.mediaId === zoom.record.action.projectItemId &&
			!clip.hidden &&
			overlaps({ clip, start: zoom.start, end: zoom.end }),
	);
	if (spanned.length === 0 || spanned.some(hasOwnTransformKeys)) return null;
	const ramp = Math.min(ZOOM_RAMP_SECONDS, (zoom.end - zoom.start) / 3);
	const clips = track.clips.map((clip): VideoTrack["clips"][number] => {
		if (!spanned.includes(clip)) return clip;
		const clipStart = seconds(clip.startTime);
		const clipEnd = clipStart + seconds(clip.duration);
		const times = [
			zoom.start,
			zoom.start + ramp,
			zoom.end - ramp,
			zoom.end,
			clipStart,
			clipEnd,
		]
			.filter((time) => time >= clipStart && time <= clipEnd)
			.filter((time) => time >= zoom.start && time <= zoom.end)
			.sort((a, b) => a - b)
			.filter(
				(time, index, all) =>
					index === 0 || time - all[index - 1] > TIME_EPSILON,
			);
		const base = {
			"transform.positionX": numberParam({
				clip: clip,
				key: "transform.positionX",
				fallback: 0,
			}),
			"transform.positionY": numberParam({
				clip: clip,
				key: "transform.positionY",
				fallback: 0,
			}),
			"transform.scaleX": numberParam({
				clip: clip,
				key: "transform.scaleX",
				fallback: 1,
			}),
			"transform.scaleY": numberParam({
				clip: clip,
				key: "transform.scaleY",
				fallback: 1,
			}),
		};
		const zoomed = {
			"transform.positionX":
				(base["transform.positionX"] - zoom.view.center.x) * zoom.view.scale,
			"transform.positionY":
				(base["transform.positionY"] - zoom.view.center.y) * zoom.view.scale,
			"transform.scaleX": base["transform.scaleX"] * zoom.view.scale,
			"transform.scaleY": base["transform.scaleY"] * zoom.view.scale,
		};
		const animations = { ...clip.animations };
		for (const path of ZOOM_CHANNELS) {
			const existing = animations[path];
			const keys: ScalarAnimationKey[] = [
				...(isLeafChannelData(existing) && isScalarChannel(existing)
					? existing.keys
					: []),
				...times.map((time, index) => {
					const amount = zoomAmount({ zoom, time });
					return {
						id: `graphics-zoom:${zoom.record.id}:${clip.id}:${path}:${index}`,
						time: ticks(time - clipStart),
						value: base[path] + (zoomed[path] - base[path]) * amount,
						segmentToNext: "bezier" as const,
						tangentMode: "flat" as const,
					};
				}),
			].sort((a, b) => a.time - b.time);
			animations[path] = { keys };
		}
		return {
			...clip,
			animations,
			zoomGraphicIds: [...(clip.zoomGraphicIds ?? []), zoom.record.id],
		};
	});
	const update = <TTrack extends VideoTrack>(candidate: TTrack): TTrack =>
		candidate.id === track.id ? { ...candidate, clips } : candidate;
	return {
		...tracks,
		main: update(tracks.main),
		overlay: tracks.overlay.map((candidate) =>
			candidate.type === "video" ? update(candidate) : candidate,
		),
	};
}

// ---------------------------------------------------------------------------
// Placing graphics: the sync that runs after every edit

const sameTime = ({ a, b }: { a: number; b: number }) =>
	Math.abs(a - b) < TIME_EPSILON;
const samePosition = ({ a, b }: { a: Point; b: Point }) =>
	Math.abs(a.x - b.x) < POSITION_EPSILON &&
	Math.abs(a.y - b.y) < POSITION_EPSILON;
const sameScale = ({ a, b }: { a: number; b: number }) =>
	Math.abs(a - b) < SCALE_EPSILON * Math.max(1, Math.abs(b));

export function effectiveValues(record: GraphicRecord): GraphicValues {
	const { hidden: _hidden, ...overrides } = record.overrides;
	return { ...record.planned, ...overrides };
}

function tombstoneFor(record: GraphicRecord): GraphicTombstone {
	return {
		key: record.key,
		kind: record.kind,
		projectItemId: record.action.projectItemId,
		action: record.action.time,
	};
}

function flag({
	code,
	message,
}: {
	code: GraphicFlag["code"];
	message: string;
}): GraphicFlag {
	return { code, message };
}

/** Records the creator's changes to a placed graphic's clip as overrides. */
function captureAdjustments({
	record,
	clip,
	canvas,
	timingComparable,
}: {
	record: GraphicRecord;
	clip: TimelineClip;
	canvas: CanvasSize;
	timingComparable: boolean;
}): GraphicOverrides {
	const placed = record.placed;
	if (!placed) return record.overrides;
	const now = readGraphicClip({ clip, kind: record.kind, canvas });
	const overrides = { ...record.overrides };
	if (now.hidden !== placed.hidden) overrides.hidden = now.hidden;
	if (!samePosition({ a: now.position, b: placed.position ?? { x: 0, y: 0 } }))
		overrides.position = now.position;
	if (!sameScale({ a: now.scale, b: placed.scale ?? 1 }))
		overrides.scale = now.scale;
	if (
		now.scaleY !== undefined &&
		!sameScale({ a: now.scaleY, b: placed.scaleY ?? placed.scale ?? 1 })
	)
		overrides.scaleY = now.scaleY;
	if (record.kind === "card" && now.text !== placed.text)
		overrides.text = now.text;
	// A cut moves graphics with the picture; only a change while the picture
	// stayed put is the creator retiming the graphic.
	if (timingComparable) {
		const offset = now.start - placed.anchor;
		if (!sameTime({ a: offset, b: placed.start })) overrides.start = offset;
		if (!sameTime({ a: now.duration, b: placed.duration }))
			overrides.duration = now.duration;
	}
	return overrides;
}

/**
 * Places each graphic at its offset from the source action and preserves
 * creator changes. Records whose action left the cut get a review flag.
 */
export function syncGraphics({
	sequence,
	projectItems,
	canvas,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics">;
	projectItems: ProjectItem[];
	canvas: CanvasSize;
}): { tracks: SequenceTracks; graphics: SequenceGraphics } | null {
	const graphics = sequence.graphics;
	if (!graphics) return null;
	const sizes = itemSizes(projectItems);
	let tracks = sequence.tracks;
	const screen = screenSignature(tracks);
	const screenUnchanged = graphics.screen === screen;

	// A split can leave two clips for one graphic. Keep its original handle.
	const byId = new Map(graphics.records.map((record) => [record.id, record]));
	const shown = new Map<string, { trackId: string; clip: TimelineClip }>();
	const loose: Array<{ trackId: string; clip: TimelineClip }> = [];
	for (const track of tracks.overlay) {
		for (const clip of track.clips) {
			if (!clip.graphicId) continue;
			const entry = { trackId: track.id, clip };
			const record = byId.get(clip.graphicId);
			const current = shown.get(clip.graphicId);
			if (
				!record ||
				(record.kind === "card"
					? clip.type !== "text"
					: clip.type !== "graphic")
			)
				loose.push(entry);
			else if (!current) shown.set(clip.graphicId, entry);
			else if (record.placed?.clipId === clip.id) {
				loose.push(current);
				shown.set(clip.graphicId, entry);
			} else loose.push(entry);
		}
	}
	for (const { clip } of loose) {
		tracks = filterGraphicTracks({ tracks, keep: ({ id }) => id !== clip.id });
	}

	const pictureEnd = videoTracks(tracks).reduce(
		(end, track) =>
			track.clips.reduce(
				(end, clip) =>
					Math.max(end, seconds(clip.startTime) + seconds(clip.duration)),
				end,
			),
		0,
	);
	const records: GraphicRecord[] = [];
	const placedZooms: ZoomPlacement[] = [];
	tracks = withoutZoomKeys({ tracks, keepNewKeys: screenUnchanged });
	const ordered = graphics.records.toSorted(
		(a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
	);
	for (const record of ordered) {
		const current = shown.get(record.id);
		const anchor = locateSourceTime({
			tracks,
			projectItemId: record.action.projectItemId,
			sourceTime: record.action.time,
			near: record.placed?.anchor,
		});
		const overrides = current
			? captureAdjustments({
					record,
					clip: current.clip,
					canvas,
					timingComparable:
						screenUnchanged &&
						!!anchor &&
						!!record.placed &&
						Math.abs(anchor.time - record.placed.anchor) < TIME_EPSILON,
				})
			: record.overrides;
		const adjusted = { ...record, overrides };
		if (!anchor) {
			if (current)
				tracks = filterGraphicTracks({
					tracks,
					keep: ({ id }) => id !== current.clip.id,
				});
			records.push({
				...adjusted,
				placed: undefined,
				flags: [
					flag({
						code: "action_missing",
						message: `Its action (${record.action.time.toFixed(2)} s in the recording) is no longer in the cut. Review it: delete it, or restore the take that shows the action.`,
					}),
				],
			});
			continue;
		}
		const flags: GraphicFlag[] = [];
		if (
			passageCoverage({ tracks, passage: record.passage, projectItems }) <
			MIN_PASSAGE_COVERAGE
		)
			flags.push(
				flag({
					code: "passage_changed",
					message:
						"Part of the narration it illustrates was cut or swapped. Check that it still fits.",
				}),
			);

		const values = effectiveValues(adjusted);
		const hidden = overrides.hidden ?? false;
		const start = Math.max(0, anchor.time + values.start);
		// Clip against the end of the picture so a graphic cannot extend the export.
		const duration = Math.min(
			pictureEnd - start,
			values.duration + Math.min(0, anchor.time + values.start),
		);
		if (duration <= 0 || ticks(duration) <= 0) {
			if (current)
				tracks = filterGraphicTracks({
					tracks,
					keep: ({ id }) => id !== current.clip.id,
				});
			records.push({
				...adjusted,
				placed: undefined,
				flags: [
					...flags,
					flag({
						code: "timing_outside_picture",
						message:
							"Its timing falls beyond the last picture clip. Replan its timing or delete it.",
					}),
				],
			});
			continue;
		}
		if (record.kind === "highlight" && record.target) {
			const midpoint = start + duration / 2;
			const picture = videoTracks(tracks)
				.find(({ id }) => id === anchor.trackId)
				?.clips.find(
					(clip): clip is VideoClip =>
						clip.type === "video" &&
						!clip.hidden &&
						clip.mediaId === record.action.projectItemId &&
						seconds(clip.startTime) <= midpoint &&
						midpoint < seconds(clip.startTime) + seconds(clip.duration),
				);
			const frame = screenFrame({
				clip: picture ?? anchor.clip,
				size: sizes.get(record.action.projectItemId),
				canvas,
				time: picture ? midpoint : anchor.time,
			});
			const box = targetOnCanvas({ frame, target: record.target });
			const width = Math.abs(box.width);
			const height = Math.abs(box.height);
			const aspect = Math.min(20, Math.max(0.05, width / height || 1));
			const unit = highlightBoxSize({ aspect, size: 1 });
			const paddedSide = Math.max(
				(width + 2 * HIGHLIGHT_PADDING) / unit.width,
				(height + 2 * HIGHLIGHT_PADDING) / unit.height,
			);
			values.position = overrides.position ?? box.center;
			values.scale = overrides.scale ?? paddedSide / handleSide(canvas);
		}

		const params = graphicClipParams({ record, values, canvas, sizes });
		const type = trackKind(record.kind);
		let clipId: string;
		if (
			current &&
			(current.clip.type === "graphic" || current.clip.type === "text")
		) {
			const clip = current.clip;
			const { hidden: _hidden, ...shownClip } = clip;
			const next = {
				...shownClip,
				startTime: ticks(start),
				duration: ticks(duration),
				trimStart: ticks(0),
				trimEnd: ticks(0),
				params: { ...clip.params, ...params },
				...(hidden && { hidden: true }),
			};
			const track = tracks.overlay.find(({ id }) => id === current.trackId);
			const fits =
				track?.type === type &&
				!track.clips.some(
					(other) =>
						other.id !== clip.id &&
						overlaps({ clip: other, start, end: start + duration }),
				);
			tracks = fits
				? {
						...tracks,
						overlay: tracks.overlay.map((candidate) =>
							candidate === track
								? writeGraphicClip({ track: candidate, clip: next })
								: candidate,
						),
					}
				: placeClip({
						tracks: filterGraphicTracks({
							tracks,
							keep: ({ id }) => id !== clip.id,
						}),
						clip: next,
					});
			clipId = clip.id;
		} else {
			const clip = newGraphicClip({ record, params, start, duration, canvas });
			if (hidden) clip.hidden = true;
			tracks = placeClip({ tracks, clip });
			clipId = clip.id;
		}
		const placed = {
			start: start - anchor.time,
			duration,
			position: values.position,
			scale: values.scale,
			scaleY: values.scaleY,
			text: values.text,
			clipId,
			hidden,
			anchor: anchor.time,
		};
		const trackHidden = tracks.overlay.some(
			(track) => track.hidden && track.clips.some(({ id }) => id === clipId),
		);
		if (record.kind === "zoom" && !hidden && !trackHidden) {
			const zoom: ZoomPlacement = {
				record,
				trackId: anchor.trackId,
				start,
				end: start + duration,
				view: {
					center: values.position ?? { x: 0, y: 0 },
					scale: values.scale ?? 1,
				},
			};
			const clash = placedZooms.some(
				(other) =>
					other.trackId === zoom.trackId &&
					other.start < zoom.end &&
					zoom.start < other.end,
			);
			const next = clash ? null : addZoomKeys({ tracks, zoom });
			if (next) {
				tracks = next;
				placedZooms.push(zoom);
			} else {
				flags.push(
					flag({
						code: "zoom_conflict",
						message:
							"Zoom could not be placed on the picture because it overlaps another zoom, has no matching picture in its range, or conflicts with picture keyframes.",
					}),
				);
			}
		}
		records.push({ ...adjusted, placed, flags });
	}

	return {
		tracks,
		graphics: {
			records,
			tombstones: graphics.tombstones,
			screen,
		},
	};
}

// ---------------------------------------------------------------------------
// Planning a pass

export type GraphicPlanStatus =
	| "create"
	| "update"
	| "skip_deleted"
	| "skip_left_wide"
	| "skip_duplicate"
	| "skip_not_in_cut";

export interface GraphicPlanEntry {
	key: string;
	kind: GraphicKind;
	status: GraphicPlanStatus;
	/** The graphic's id, for those created or updated. */
	id?: string;
	reason?: string;
	/** Properties the creator adjusted, which keep their values. */
	keeps?: GraphicProperty[];
	/** Where it shows on the sequence, in seconds. */
	start?: number;
	end?: number;
}

const planKey = (graphic: PlannedGraphic) =>
	graphic.key ??
	`${graphic.kind}:${graphic.projectItemId}:${(graphic.action ?? graphic.passage.start).toFixed(3)}`;

interface ActionIdentity {
	kind: GraphicKind;
	projectItemId: string;
	action: number;
}

const sameAction = ({ a, b }: { a: ActionIdentity; b: ActionIdentity }) =>
	a.kind === b.kind &&
	a.projectItemId === b.projectItemId &&
	Math.abs(a.action - b.action) <= SAME_ACTION_SECONDS;

function withoutTarget(record: GraphicRecord): GraphicRecord {
	const { target: _target, ...rest } = record;
	return rest;
}

const KIND_ORDER: Record<GraphicKind, number> = {
	zoom: 0,
	highlight: 1,
	card: 2,
};

/** Puts a card in the half of the screen away from the target, lower down by default. */
function cardPosition({
	target,
	canvas,
}: {
	target: CanvasRect | null;
	canvas: CanvasSize;
}): Point {
	if (!target) return { x: 0, y: canvas.height * 0.22 };
	return {
		x: target.center.x > 0 ? -canvas.width * 0.24 : canvas.width * 0.24,
		y: target.center.y > 0 ? -canvas.height * 0.2 : canvas.height * 0.2,
	};
}

/**
 * Merges a planned pass into a sequence's graphics. A graphic matching an
 * earlier one, by key or by kind and action, updates it and keeps the
 * creator's adjustments; deleted graphics stay deleted; uncertain targets
 * leave the shot wide. Placement happens in `syncGraphics`.
 */
export function planGraphicsPass({
	sequence,
	planned,
	prune,
	projectItems,
	canvas,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics">;
	planned: PlannedGraphic[];
	prune: boolean;
	projectItems: ProjectItem[];
	canvas: CanvasSize;
}): {
	graphics: SequenceGraphics;
	entries: GraphicPlanEntry[];
	removedIds: string[];
} {
	const sizes = itemSizes(projectItems);
	const tracks = sequence.tracks;
	const existing = sequence.graphics ?? { records: [], tombstones: [] };
	const records = [...existing.records];
	const matched = new Set<string>();
	const leftWide = new Set<string>();
	const entries: GraphicPlanEntry[] = [];
	const ordered = planned
		.map((graphic, index) => ({ graphic, index }))
		.sort(
			(a, b) =>
				KIND_ORDER[a.graphic.kind] - KIND_ORDER[b.graphic.kind] ||
				a.index - b.index,
		);
	const results: Array<{ index: number; entry: GraphicPlanEntry }> = [];

	for (const { graphic, index } of ordered) {
		const key = planKey(graphic);
		const action = graphic.action ?? graphic.passage.start;
		const identity = {
			kind: graphic.kind,
			projectItemId: graphic.projectItemId,
			action,
		};
		const report = (entry: Omit<GraphicPlanEntry, "key" | "kind">) =>
			results.push({ index, entry: { key, kind: graphic.kind, ...entry } });

		if (
			existing.tombstones.some(
				(tombstone) =>
					tombstone.key === key || sameAction({ a: tombstone, b: identity }),
			)
		) {
			report({
				status: "skip_deleted",
				reason: "The creator deleted this graphic. It stays deleted.",
			});
			continue;
		}
		const match =
			records.find((record) => record.key === key) ??
			records.find((record) =>
				sameAction({
					a: {
						kind: record.kind,
						projectItemId: record.action.projectItemId,
						action: record.action.time,
					},
					b: identity,
				}),
			);
		if (match && (matched.has(match.id) || match.kind !== graphic.kind)) {
			report({
				status: "skip_duplicate",
				id: match.id,
				reason: "A graphic already uses this key or covers the same action.",
			});
			continue;
		}
		if (graphic.kind !== "card" && graphic.confidence === "low") {
			if (match) {
				matched.add(match.id);
				leftWide.add(match.id);
			}
			report({
				status: "skip_left_wide",
				...(match && { id: match.id }),
				reason: "The target is uncertain, so the shot stays wide.",
			});
			continue;
		}
		const anchor = locateSourceTime({
			tracks,
			projectItemId: graphic.projectItemId,
			sourceTime: action,
		});
		if (!anchor) {
			if (match) matched.add(match.id);
			report({
				status: "skip_not_in_cut",
				...(match && { id: match.id }),
				reason: `The recording's ${action.toFixed(2)} s isn't on the sequence's picture.`,
			});
			continue;
		}
		const shownFrom = graphic.start ?? graphic.passage.start;
		const shownTo = graphic.end ?? graphic.passage.end;
		const frame = screenFrame({
			clip: anchor.clip,
			size: sizes.get(graphic.projectItemId),
			canvas,
		});
		const target = graphic.target
			? targetOnCanvas({ frame, target: graphic.target })
			: null;
		const { rate } = sourceRange(anchor.clip);
		const values: GraphicValues = {
			start: (shownFrom - action) / rate,
			duration: Math.max(MIN_GRAPHIC_SECONDS, (shownTo - shownFrom) / rate),
		};
		if (graphic.kind === "zoom" && target) {
			const view = planZoomView({
				frame,
				target,
				canvas,
				maxZoom: graphic.maxZoom,
			});
			if (!view) {
				if (match) {
					matched.add(match.id);
					leftWide.add(match.id);
				}
				report({
					status: "skip_left_wide",
					...(match && { id: match.id }),
					reason: "The target is already legible without a zoom.",
				});
				continue;
			}
			values.position = view.center;
			values.scale = view.scale;
		}
		if (graphic.kind === "card") {
			values.position = cardPosition({ target, canvas });
			values.scale = 1;
			values.text = cardText(graphic);
		}
		const passage = {
			projectItemId: graphic.passage.projectItemId ?? graphic.projectItemId,
			start: graphic.passage.start,
			end: graphic.passage.end,
			...(graphic.passage.text !== undefined && { text: graphic.passage.text }),
		};
		const fields = {
			// A graphic matched by its action keeps the key it was planned with.
			key: graphic.key ?? match?.key ?? key,
			kind: graphic.kind,
			passage,
			action: { projectItemId: graphic.projectItemId, time: action },
			...(graphic.target && { target: graphic.target }),
			planned: values,
		};
		const record: GraphicRecord = match
			? { ...withoutTarget(match), ...fields }
			: { id: generateUUID(), ...fields, overrides: {}, flags: [] };
		if (match) records[records.indexOf(match)] = record;
		else records.push(record);
		matched.add(record.id);
		const effective = effectiveValues(record);
		const start = Math.max(0, anchor.time + effective.start);
		report({
			status: match ? "update" : "create",
			id: record.id,
			keeps: GRAPHIC_PROPERTIES.filter(
				(property) => record.overrides[property] !== undefined,
			),
			start: Number(start.toFixed(3)),
			end: Number((start + effective.duration).toFixed(3)),
		});
	}

	const removedIds: string[] = [];
	const kept = records.filter((record) => {
		const stale =
			(leftWide.has(record.id) || (prune && !matched.has(record.id))) &&
			Object.values(record.overrides).every((value) => value === undefined);
		if (stale) removedIds.push(record.id);
		return !stale;
	});
	for (const { entry } of results.sort((a, b) => a.index - b.index))
		entries.push(entry);
	return {
		graphics: { ...existing, records: kept },
		entries,
		removedIds,
	};
}

/** Removes the clips that show the given graphics. */
export function withoutGraphicClips({
	tracks,
	graphicIds,
}: {
	tracks: SequenceTracks;
	graphicIds: string[];
}): SequenceTracks {
	if (graphicIds.length === 0) return tracks;
	const ids = new Set(graphicIds);
	return filterGraphicTracks({
		tracks,
		keep: ({ graphicId }) => !graphicId || !ids.has(graphicId),
	});
}

/** Finds the clip that shows a graphic. */
export function findGraphicClip({
	tracks,
	graphicId,
}: {
	tracks: SequenceTracks;
	graphicId: string;
}): { trackId: string; clip: TimelineClip } | null {
	for (const track of tracks.overlay)
		for (const clip of track.clips)
			if (clip.graphicId === graphicId) return { trackId: track.id, clip };
	return null;
}

/** One graphic as `graphics_list` and the Graphics panel describe it. */
export interface GraphicSummary {
	id: string;
	key: string;
	kind: GraphicKind;
	/** "shown" and "hidden" are on the sequence; "off" means its action left the cut. */
	status: "shown" | "hidden" | "off";
	clipId?: string;
	/** Sequence seconds. */
	start?: number;
	end?: number;
	passage: GraphicRecord["passage"];
	action: GraphicRecord["action"];
	target?: TargetRect;
	text?: string;
	/** Properties the creator adjusted. */
	adjusted: GraphicProperty[];
	flags: GraphicFlag[];
}

export function summarizeGraphics({
	sequence,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics">;
}): GraphicSummary[] {
	return (sequence.graphics?.records ?? [])
		.map((record): GraphicSummary => {
			const placed = record.placed;
			const values = effectiveValues(record);
			return {
				id: record.id,
				key: record.key,
				kind: record.kind,
				status: !placed
					? "off"
					: placed.hidden ||
						  sequence.tracks.overlay.some(
								(track) =>
									track.hidden &&
									track.clips.some(({ id }) => id === placed.clipId),
						  )
						? "hidden"
						: "shown",
				...(placed && {
					clipId: placed.clipId,
					start: Number((placed.anchor + placed.start).toFixed(3)),
					end: Number(
						(placed.anchor + placed.start + placed.duration).toFixed(3),
					),
				}),
				passage: record.passage,
				action: record.action,
				...(record.target && { target: record.target }),
				...(values.text !== undefined && { text: values.text }),
				adjusted: GRAPHIC_PROPERTIES.filter(
					(property) => record.overrides[property] !== undefined,
				),
				flags: record.flags,
			};
		})
		.sort(
			(a, b) =>
				(a.start ?? Number.POSITIVE_INFINITY) -
				(b.start ?? Number.POSITIVE_INFINITY),
		);
}

/** A graphic that needs the creator's review, for the export gate's issue list. */
export interface GraphicReviewIssue {
	graphicId: string;
	kind: GraphicKind;
	code: GraphicFlag["code"];
	message: string;
	/** Sequence seconds, when the graphic is on the sequence. */
	time?: number;
}

export function graphicReviewIssues({
	sequence,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics">;
}): GraphicReviewIssue[] {
	return summarizeGraphics({ sequence }).flatMap((graphic) =>
		graphic.flags.map((item) => ({
			graphicId: graphic.id,
			kind: graphic.kind,
			code: item.code,
			message: item.message,
			...(graphic.start !== undefined && { time: graphic.start }),
		})),
	);
}

/** Remembers explicit deletions so later passes cannot recreate them. */
export function tombstoneGraphics({
	graphics,
	graphicIds,
}: {
	graphics: SequenceGraphics | undefined;
	graphicIds: readonly string[];
}): SequenceGraphics | undefined {
	if (!graphics || graphicIds.length === 0) return graphics;
	const deleted = graphics.records.filter(({ id }) => graphicIds.includes(id));
	if (deleted.length === 0) return graphics;
	return {
		...graphics,
		records: graphics.records.filter(({ id }) => !graphicIds.includes(id)),
		tombstones: [...graphics.tombstones, ...deleted.map(tombstoneFor)],
	};
}

export function deleteGraphic({
	sequence,
	graphicId,
}: {
	sequence: Pick<TSequence, "tracks" | "graphics">;
	graphicId: string;
}): Pick<TSequence, "tracks" | "graphics"> | null {
	const graphics = tombstoneGraphics({
		graphics: sequence.graphics,
		graphicIds: [graphicId],
	});
	if (graphics === sequence.graphics) return null;
	return {
		tracks: withoutGraphicClips({
			tracks: sequence.tracks,
			graphicIds: [graphicId],
		}),
		graphics,
	};
}
