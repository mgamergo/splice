import type { ShortStyle } from "@splice/bridge";
import { captionWordKey } from "@/agent/short-caption-corrections";
import type { CaptionStyle } from "@splice/bridge/ops";
import {
	coversAction,
	textBounds,
	type OverlayRegion,
} from "@/agent/overlay-bounds";
import type { TCanvasSize } from "@/project/types";
import type { SequenceTracks, TextClip } from "@/timeline/types";
import { mediaTimeToSeconds } from "@/wasm";

export const CAPTION_TRACK_NAME = "Captions";

const POSITION_X = "transform.positionX";
const POSITION_Y = "transform.positionY";
const PASSAGE_GAP_SECONDS = 0.5;
const seconds = (time: TextClip["startTime"]) => mediaTimeToSeconds({ time });
const clipEnd = (clip: TextClip) => clip.startTime + clip.duration;
type Position = NonNullable<CaptionStyle["position"]>;
type CaptionAnchor = Position | "upper" | "lower";
const plainText = (text: unknown) =>
	String(text ?? "")
		.trim()
		.replace(/\s+/g, " ");

function manuallyPlaced(clip: TextClip) {
	return (
		!clip.captionLayout ||
		clip.captionLayout.manualPosition ||
		clip.animations?.[POSITION_Y] !== undefined ||
		clip.animations?.[POSITION_X] !== undefined ||
		clip.params[POSITION_Y] !== clip.captionLayout.y ||
		Math.abs(Number(clip.params[POSITION_X] ?? 0)) > 0.5
	);
}

/** Keeps direct position edits even when caption grouping changes. */
export function carryCaptionEdits({
	clips,
	previous,
}: {
	clips: TextClip[];
	previous: TextClip[];
}): TextClip[] {
	const byStart = new Map(previous.map((clip) => [clip.startTime, clip]));
	const placed = previous
		.filter((clip) => clip.captionLayout && manuallyPlaced(clip))
		.sort((a, b) => a.startTime - b.startTime);
	let first = 0;
	return clips.map((clip) => {
		while (first < placed.length && clipEnd(placed[first]) <= clip.startTime)
			first++;
		const exact = byStart.get(clip.startTime);
		const overlap = placed[first];
		const manual =
			exact && manuallyPlaced(exact)
				? exact
				: overlap && overlap.startTime < clipEnd(clip)
					? overlap
					: undefined;
		const previousParts = exact?.captionLayout?.parts;
		const currentParts = clip.captionLayout?.parts;
		const sameText =
			exact?.captionLayout &&
			plainText(exact.captionLayout.text) ===
				plainText(clip.captionLayout?.text);
		const sameWords =
			previousParts && currentParts
				? JSON.stringify(
						previousParts.flatMap(({ words }) => words.map(captionWordKey)),
					) ===
					JSON.stringify(
						currentParts.flatMap(({ words }) => words.map(captionWordKey)),
					)
				: sameText;
		const legacyText =
			sameText &&
			!previousParts &&
			exact &&
			plainText(exact.params.content) !== plainText(exact.captionLayout?.text);
		if (!manual && !(sameWords && exact?.hidden) && !legacyText) return clip;
		return {
			...clip,
			...(manual &&
				clip.captionLayout && {
					captionLayout: { ...clip.captionLayout, manualPosition: true },
				}),
			...(sameWords && exact?.hidden && { hidden: true }),
			...(manual?.animations && { animations: manual.animations }),
			params: {
				...clip.params,
				...(manual && {
					[POSITION_X]: manual.params[POSITION_X],
					[POSITION_Y]: manual.params[POSITION_Y],
				}),
				...(legacyText && { content: exact.params.content }),
			},
		};
	});
}

function atPosition({
	clip,
	canvas,
	position,
	bounds,
}: {
	clip: TextClip;
	canvas: TCanvasSize;
	position: CaptionAnchor;
	bounds: ReturnType<typeof textBounds>;
}) {
	const fartherFromCenter = position === "upper" || position === "lower";
	const edge =
		canvas.height * (fartherFromCenter ? 0.34 : 0.28) - bounds.height / 2;
	const centerY =
		position === "middle"
			? 0
			: position === "top" || position === "upper"
				? -edge
				: edge;
	const y = Math.round(
		centerY - (bounds.center.y - Number(clip.params[POSITION_Y] ?? 0)),
	);
	return { y, rect: { ...bounds, center: { x: bounds.center.x, y: centerY } } };
}

/** Picks a location for a continuous passage, moving within it only when needed. */
export function placeShortCaptions({
	tracks,
	canvas,
	style,
	position,
	regions,
}: {
	tracks: SequenceTracks;
	canvas: TCanvasSize;
	style: ShortStyle;
	position?: Position;
	regions: OverlayRegion[];
}): SequenceTracks {
	const preferred = style === "raw" ? "bottom" : "middle";
	const order: CaptionAnchor[] =
		style === "raw"
			? ["bottom", "middle", "top", "lower", "upper"]
			: ["middle", "bottom", "top", "lower", "upper"];
	let changed = false;
	const overlay = tracks.overlay.map((track) => {
		if (
			track.type !== "text" ||
			track.name !== CAPTION_TRACK_NAME ||
			track.hidden
		)
			return track;
		const ordered = track.clips.toSorted((a, b) => a.startTime - b.startTime);
		const placements = new Map<string, TextClip>();
		for (let first = 0; first < ordered.length; ) {
			let last = first + 1;
			while (
				last < ordered.length &&
				seconds(ordered[last].startTime) -
					seconds(ordered[last - 1].startTime) -
					seconds(ordered[last - 1].duration) <=
					PASSAGE_GAP_SECONDS
			)
				last++;
			const passage = ordered
				.slice(first, last)
				.filter((clip) => !clip.hidden && !manuallyPlaced(clip))
				.map((clip) => {
					const bounds = textBounds({ clip, canvas });
					const start = seconds(clip.startTime);
					const end = start + seconds(clip.duration);
					const actions = regions.filter(
						(region) => region.start < end && region.end > start,
					);
					return { clip, bounds, actions };
				});
			const clear = ({
				item: { clip, bounds, actions },
				candidate,
			}: {
				item: (typeof passage)[number];
				candidate: CaptionAnchor;
			}) => {
				const { rect } = atPosition({
					clip,
					canvas,
					position: candidate,
					bounds,
				});
				return !actions.some((action) =>
					coversAction({ overlay: rect, action }),
				);
			};
			let current =
				position ??
				(passage.every((item) => clear({ item, candidate: preferred }))
					? preferred
					: (order.find((candidate) =>
							passage.every((item) => clear({ item, candidate })),
						) ?? preferred));
			for (const item of passage) {
				if (!position && !clear({ item, candidate: current }))
					current =
						order.find((candidate) => clear({ item, candidate })) ?? current;
				const { clip, bounds } = item;
				const { y } = atPosition({ clip, canvas, position: current, bounds });
				if (clip.params[POSITION_Y] === y || !clip.captionLayout) continue;
				placements.set(clip.id, {
					...clip,
					params: { ...clip.params, [POSITION_Y]: y },
					captionLayout: { ...clip.captionLayout, y },
				});
			}
			first = last;
		}
		if (!placements.size) return track;
		changed = true;
		return {
			...track,
			clips: track.clips.map((clip) => placements.get(clip.id) ?? clip),
		};
	});
	return changed ? { ...tracks, overlay } : tracks;
}
