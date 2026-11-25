import { buildTransformFromParams } from "@/rendering";
import type { ProjectItem } from "@/media/types";
import type { TCanvasSize } from "@/project/types";
import type { SequenceTracks } from "@/timeline/types";

/** Fill the Short canvas when the recording still has its default framing. */
export function fillExplainerPicture({
	tracks,
	canvas,
	projectItems,
}: {
	tracks: SequenceTracks;
	canvas: TCanvasSize;
	projectItems: ProjectItem[];
}): SequenceTracks {
	const sizes = new Map(
		projectItems.map(({ id, width, height }) => [id, { width, height }]),
	);
	const clips = tracks.main.clips.map((clip) => {
		if (clip.type !== "video" || clip.animations) return clip;
		const size = sizes.get(clip.mediaId);
		if (!size?.width || !size.height || size.width >= size.height) return clip;
		const { position, rotate, scaleX, scaleY } = buildTransformFromParams({
			params: clip.params,
		});
		if (position.x || position.y || rotate || scaleX !== 1 || scaleY !== 1)
			return clip;
		const ratios = [canvas.width / size.width, canvas.height / size.height];
		const scale = Math.max(...ratios) / Math.min(...ratios);
		return scale <= 1
			? clip
			: {
					...clip,
					params: {
						...clip.params,
						"transform.scaleX": scale,
						"transform.scaleY": scale,
					},
				};
	});
	return clips.every((clip, index) => clip === tracks.main.clips[index])
		? tracks
		: { ...tracks, main: { ...tracks.main, clips } };
}
