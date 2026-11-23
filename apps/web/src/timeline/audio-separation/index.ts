import { cloneAnimations } from "@/animation";
import type { ClipAnimations } from "@/animation/types";
import type { ProjectItem } from "@/media/types";
import { DEFAULTS } from "@/timeline/defaults";
import type {
	CreateUploadAudioClip,
	TimelineClip,
	AudioClip,
	VideoClip,
} from "../types";

type MediaAudioState = Pick<ProjectItem, "hasAudio">;

export function isSourceAudioEnabled({
	clip,
}: {
	clip: VideoClip;
}): boolean {
	return clip.isSourceAudioEnabled !== false;
}

export function isSourceAudioSeparated({
	clip,
}: {
	clip: VideoClip;
}): boolean {
	return !isSourceAudioEnabled({ clip });
}

export function canExtractSourceAudio(
	clip: TimelineClip,
	projectItem: MediaAudioState | null | undefined,
): clip is VideoClip {
	return (
		clip.type === "video" &&
		isSourceAudioEnabled({ clip }) &&
		!!projectItem &&
		projectItem.hasAudio !== false
	);
}

export function canRecoverSourceAudio(
	clip: TimelineClip,
): clip is VideoClip {
	return clip.type === "video" && isSourceAudioSeparated({ clip });
}

export function canToggleSourceAudio(
	clip: TimelineClip,
	projectItem: MediaAudioState | null | undefined,
): clip is VideoClip {
	return (
		canRecoverSourceAudio(clip) || canExtractSourceAudio(clip, projectItem)
	);
}

export function doesClipHaveEnabledAudio({
	clip,
	projectItem,
}: {
	clip: AudioClip | VideoClip;
	projectItem?: MediaAudioState | null;
}): boolean {
	if (clip.type === "audio") {
		return true;
	}

	return (
		!!projectItem &&
		projectItem.hasAudio !== false &&
		isSourceAudioEnabled({ clip })
	);
}

export function buildSeparatedAudioClip({
	sourceClip,
}: {
	sourceClip: VideoClip;
}): CreateUploadAudioClip {
	return {
		type: "audio",
		sourceType: "upload",
		mediaId: sourceClip.mediaId,
		bestTakeMarkerIds: sourceClip.bestTakeMarkerIds,
		sourceAudioGroupId: sourceClip.sourceAudioGroupId,
		name: sourceClip.name,
		duration: sourceClip.duration,
		startTime: sourceClip.startTime,
		trimStart: sourceClip.trimStart,
		trimEnd: sourceClip.trimEnd,
		sourceDuration: sourceClip.sourceDuration,
		params: {
			volume:
				typeof sourceClip.params.volume === "number"
					? sourceClip.params.volume
					: DEFAULTS.clip.volume,
			muted: sourceClip.params.muted === true,
		},
		retime: sourceClip.retime
			? {
					rate: sourceClip.retime.rate,
					maintainPitch: sourceClip.retime.maintainPitch,
				}
			: undefined,
		animations: cloneVolumeAnimations({
			animations: sourceClip.animations,
		}),
	};
}

export function getSourceAudioActionLabel({
	clip,
}: {
	clip: VideoClip;
}): "Extract audio" | "Recover audio" {
	return isSourceAudioSeparated({ clip })
		? "Recover audio"
		: "Extract audio";
}

function cloneVolumeAnimations({
	animations,
}: {
	animations: ClipAnimations | undefined;
}): ClipAnimations | undefined {
	const volumeData = animations?.volume;
	if (!volumeData) {
		return undefined;
	}

	return cloneAnimations({
		animations: { volume: volumeData },
		shouldRegenerateKeyframeIds: true,
	});
}
