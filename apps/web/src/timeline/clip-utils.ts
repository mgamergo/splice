import { DEFAULT_NEW_CLIP_DURATION } from "@/timeline/creation";
import {
	MASKABLE_CLIP_TYPES,
	RETIMABLE_CLIP_TYPES,
	VISUAL_CLIP_TYPES,
	type CreateEffectClip,
	type CreateGraphicClip,
	type CreateTimelineClip,
	type CreateTextClip,
	type CreateVideoClip,
	type CreateImageClip,
	type CreateStickerClip,
	type CreateUploadAudioClip,
	type CreateLibraryAudioClip,
	type TextClip,
	type SequenceTracks,
	type TimelineClip,
	type AudioClip,
	type VideoClip,
	type ImageClip,
	type MaskableClip,
	type RetimableClip,
	type VisualClip,
	type UploadAudioClip,
} from "@/timeline";
import { DEFAULTS } from "@/timeline/defaults";
import type { MediaType } from "@/media/types";
import { buildDefaultEffectInstance } from "@/effects";
import { buildDefaultGraphicInstance } from "@/graphics";
import type { ParamValues } from "@/params";
import {
	buildDefaultParamValues,
	getBuiltInClipParams,
} from "@/params/registry";
import { capitalizeFirstLetter } from "@/utils/string";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export function canClipHaveAudio(
	clip: TimelineClip,
): clip is AudioClip | VideoClip {
	return clip.type === "audio" || clip.type === "video";
}

export function isVisualClip(
	clip: TimelineClip,
): clip is VisualClip {
	return (VISUAL_CLIP_TYPES as readonly string[]).includes(clip.type);
}

export function isMaskableClip(
	clip: TimelineClip,
): clip is MaskableClip {
	return (MASKABLE_CLIP_TYPES as readonly string[]).includes(clip.type);
}

export function isRetimableClip(
	clip: TimelineClip,
): clip is RetimableClip {
	return (RETIMABLE_CLIP_TYPES as readonly string[]).includes(clip.type);
}

export function canClipBeHidden(
	clip: TimelineClip,
): clip is VisualClip {
	return isVisualClip(clip);
}

export function hasClipEffects({
	clip,
}: {
	clip: TimelineClip;
}): boolean {
	return isVisualClip(clip) && (clip.effects?.length ?? 0) > 0;
}

export function hasMediaId(
	clip: TimelineClip,
): clip is UploadAudioClip | VideoClip | ImageClip {
	return "mediaId" in clip;
}

export function requiresMediaId({
	clip,
}: {
	clip: CreateTimelineClip;
}): boolean {
	return (
		clip.type === "video" ||
		clip.type === "image" ||
		(clip.type === "audio" && clip.sourceType === "upload")
	);
}

function buildDefaultClipParams({
	type,
}: {
	type: TimelineClip["type"];
}): ParamValues {
	return buildDefaultParamValues(getBuiltInClipParams({ type }));
}

export function buildTextClip({
	raw,
	startTime,
}: {
	raw: Partial<Omit<TextClip, "type" | "id">>;
	startTime: MediaTime;
}): CreateTextClip {
	const t = raw;

	return {
		type: "text",
		name: t.name ?? DEFAULTS.text.clip.name,
		duration: t.duration ?? DEFAULT_NEW_CLIP_DURATION,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: {
			...buildDefaultClipParams({ type: "text" }),
			...(t.params ?? {}),
		},
	};
}

export function buildEffectClip({
	effectType,
	startTime,
	duration,
}: {
	effectType: string;
	startTime: MediaTime;
	duration?: MediaTime;
}): CreateEffectClip {
	const instance = buildDefaultEffectInstance({ effectType });
	return {
		type: "effect",
		name: capitalizeFirstLetter({ string: instance.type }),
		effectType,
		params: instance.params,
		duration: duration ?? DEFAULT_NEW_CLIP_DURATION,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
	};
}

export function buildStickerClip({
	stickerId,
	name,
	startTime,
	intrinsicWidth,
	intrinsicHeight,
}: {
	stickerId: string;
	name?: string;
	startTime: MediaTime;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}): CreateStickerClip {
	const stickerNameFromId =
		stickerId.split(":").slice(1).pop()?.replaceAll("-", " ") ?? stickerId;
	return {
		type: "sticker",
		name: name ?? stickerNameFromId,
		stickerId,
		intrinsicWidth,
		intrinsicHeight,
		duration: DEFAULT_NEW_CLIP_DURATION,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		params: buildDefaultClipParams({ type: "sticker" }),
	};
}

export function buildGraphicClip({
	definitionId,
	name,
	startTime,
	params,
}: {
	definitionId: string;
	name?: string;
	startTime: MediaTime;
	params?: Partial<ParamValues>;
}): CreateGraphicClip {
	const instance = buildDefaultGraphicInstance({ definitionId });
	return {
		type: "graphic",
		name: name ?? capitalizeFirstLetter({ string: instance.definitionId }),
		definitionId: instance.definitionId,
		params: mergeParamValues({
			base: {
				...buildDefaultClipParams({ type: "graphic" }),
				...instance.params,
			},
			overrides: params,
		}),
		duration: DEFAULT_NEW_CLIP_DURATION,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
	};
}

function mergeParamValues({
	base,
	overrides,
}: {
	base: ParamValues;
	overrides?: Partial<ParamValues>;
}): ParamValues {
	const result: ParamValues = { ...base };
	for (const [key, value] of Object.entries(overrides ?? {})) {
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return result;
}

function buildVideoClip({
	mediaId,
	name,
	duration,
	startTime,
}: {
	mediaId: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
}): CreateVideoClip {
	return {
		type: "video",
		mediaId,
		name,
		duration,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: duration,
		isSourceAudioEnabled: true,
		hidden: false,
		params: buildDefaultClipParams({ type: "video" }),
	};
}

function buildImageClip({
	mediaId,
	name,
	duration,
	startTime,
}: {
	mediaId: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
}): CreateImageClip {
	return {
		type: "image",
		mediaId,
		name,
		duration,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		hidden: false,
		params: buildDefaultClipParams({ type: "image" }),
	};
}

function buildUploadAudioClip({
	mediaId,
	name,
	duration,
	startTime,
	buffer,
}: {
	mediaId: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	buffer?: AudioBuffer;
}): CreateUploadAudioClip {
	const clip: CreateUploadAudioClip = {
		type: "audio",
		sourceType: "upload",
		mediaId,
		name,
		duration,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: duration,
		params: buildDefaultClipParams({ type: "audio" }),
	};
	if (buffer) {
		clip.buffer = buffer;
	}
	return clip;
}

export function buildClipFromMedia({
	mediaId,
	mediaType,
	name,
	duration,
	startTime,
	buffer,
}: {
	mediaId: string;
	mediaType: MediaType;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	buffer?: AudioBuffer;
}): CreateTimelineClip {
	switch (mediaType) {
		case "audio":
			return buildUploadAudioClip({
				mediaId,
				name,
				duration,
				startTime,
				buffer,
			});
		case "video":
			return buildVideoClip({ mediaId, name, duration, startTime });
		case "image":
			return buildImageClip({ mediaId, name, duration, startTime });
	}
}

export function buildLibraryAudioClip({
	sourceUrl,
	name,
	duration,
	startTime,
	buffer,
}: {
	sourceUrl: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	buffer?: AudioBuffer;
}): CreateLibraryAudioClip {
	const clip: CreateLibraryAudioClip = {
		type: "audio",
		sourceType: "library",
		sourceUrl,
		name,
		duration,
		startTime,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: duration,
		params: buildDefaultClipParams({ type: "audio" }),
	};
	if (buffer) {
		clip.buffer = buffer;
	}
	return clip;
}

export function getClipsAtTime({
	tracks,
	time,
}: {
	tracks: SequenceTracks;
	time: number;
}): { trackId: string; clipId: string }[] {
	const result: { trackId: string; clipId: string }[] = [];
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];

	for (const track of orderedTracks) {
		for (const clip of track.clips) {
			const clipStart = clip.startTime;
			const clipEnd = clip.startTime + clip.duration;

			if (time > clipStart && time < clipEnd) {
				result.push({ trackId: track.id, clipId: clip.id });
			}
		}
	}

	return result;
}

export function getClipFontFamilies({
	tracks,
}: {
	tracks: SequenceTracks;
}): string[] {
	const families = new Set<string>();
	for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
		for (const clip of track.clips) {
			if (clip.type === "text" && typeof clip.params.fontFamily === "string") {
				families.add(clip.params.fontFamily);
			}
			if ("masks" in clip) {
				for (const mask of clip.masks ?? []) {
					if (mask.type === "text" && mask.params.fontFamily) {
						families.add(mask.params.fontFamily);
					}
				}
			}
		}
	}
	return [...families];
}
