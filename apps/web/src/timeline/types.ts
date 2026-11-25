import type { ScalarAnimationChannel } from "@/animation/types";
import type { ClipAnimations } from "@/animation/types";
import type { Effect } from "@/effects/types";
import type { Mask } from "@/masks/types";
import type { ParamValues } from "@/params";
import type { SequenceGraphics } from "@splice/bridge/graphics";
import type { SequenceMix } from "@splice/bridge/mix";
import type { ProtectedSection, RemovalMarkerData } from "@splice/bridge/ops";
import type { MediaTime } from "@/wasm";
import type { CaptionPart, SavedShortCaptions } from "@/agent/short-caption-corrections";

export type ClipRef = {
	trackId: string;
	clipId: string;
};

interface MarkerFields {
	time: MediaTime;
	note?: string;
	color?: string;
	duration?: MediaTime;
}

export type RemovalMarker = MarkerFields & {
	id: string;
	data: RemovalMarkerData;
};

export type Marker =
	| (MarkerFields & { id?: never; data?: never })
	| RemovalMarker;

export interface TSequence {
	id: string;
	name: string;
	isMain: boolean;
	tracks: SequenceTracks;
	markers: Marker[];
	/** Teaching sections anchored to tagged clips and bounded by source ranges. */
	protectedSections?: ProtectedSection[];
	/** Transcript words and style the Captions track is rebuilt from. */
	captions?: SavedShortCaptions;
	/** The graphics pass: each graphic's evidence, plan and the creator's changes. */
	graphics?: SequenceGraphics;
	/** The final mix: fitted music and the whole-mix gain. */
	mix?: SequenceMix;
	createdAt: Date;
	updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";

interface BaseTrack {
	id: string;
	name: string;
}

export interface VideoTrack extends BaseTrack {
	type: "video";
	clips: (VideoClip | ImageClip)[];
	muted: boolean;
	hidden: boolean;
}

export interface TextTrack extends BaseTrack {
	type: "text";
	clips: TextClip[];
	hidden: boolean;
}

export interface AudioTrack extends BaseTrack {
	type: "audio";
	clips: AudioClip[];
	muted: boolean;
}

export interface GraphicTrack extends BaseTrack {
	type: "graphic";
	clips: (StickerClip | GraphicClip)[];
	hidden: boolean;
}

export interface EffectTrack extends BaseTrack {
	type: "effect";
	clips: EffectClip[];
	hidden: boolean;
}

export type TimelineTrack =
	| VideoTrack
	| TextTrack
	| AudioTrack
	| GraphicTrack
	| EffectTrack;

export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;

export interface SequenceTracks {
	overlay: OverlayTrack[];
	main: VideoTrack;
	audio: AudioTrack[];
}

export interface RetimeConfig {
	rate: number;
	maintainPitch?: boolean;
}

interface BaseAudioClip extends BaseTimelineClip {
	/** Generated on render tracks from the current narration. */
	musicDucking?: ScalarAnimationChannel;
	type: "audio";
	buffer?: AudioBuffer;
	retime?: RetimeConfig;
}

export interface UploadAudioClip extends BaseAudioClip {
	sourceType: "upload";
	mediaId: string;
}

export interface LibraryAudioClip extends BaseAudioClip {
	sourceType: "library";
	sourceUrl: string;
}

export type AudioClip = UploadAudioClip | LibraryAudioClip;

interface BaseTimelineClip {
	id: string;
	name: string;
	duration: MediaTime;
	startTime: MediaTime;
	trimStart: MediaTime;
	trimEnd: MediaTime;
	sourceDuration?: MediaTime;
	/** Removal markers or protected sections whose best take this clip represents. */
	bestTakeMarkerIds?: string[];
	/** Shared by a video clip and the audio extracted from it. */
	sourceAudioGroupId?: string;
	/** The graphics-pass graphic this clip shows: a highlight, a card or a zoom's handle. */
	graphicId?: string;
	/**
	 * Zooms whose keyframes this picture clip carries. While set, the graphics
	 * pass owns the clip's position and scale keyframes.
	 */
	zoomGraphicIds?: string[];
	animations?: ClipAnimations;
	params: ParamValues;
}

export interface VideoClip extends BaseTimelineClip {
	type: "video";
	mediaId: string;
	isSourceAudioEnabled?: boolean;
	/**
	 * Shows picture from a replacement take over narration kept from another.
	 * Its own audio starts muted; sounds brought in from it play as audio clips.
	 */
	pictureRepair?: boolean;
	hidden?: boolean;
	retime?: RetimeConfig;
	effects?: Effect[];
	masks?: Mask[];
}

export interface ImageClip extends BaseTimelineClip {
	type: "image";
	mediaId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

type ShortHookSourceAnchor = {
	projectItemId: string;
	sourceTime: number;
	preferredClipId: string;
};

export interface ShortHookAnchors {
	evidence: ShortHookSourceAnchor;
	demonstration: ShortHookSourceAnchor;
	picture: string;
	unavailable?: true;
}

export interface TextClip extends BaseTimelineClip {
	type: "text";
	shortHook?: ShortHookAnchors;
	/** Last generated caption values, used to detect direct clip edits. */
	captionLayout?: {
		y: number;
		text: string;
		parts?: CaptionPart[];
		manualPosition?: true;
	};
	hidden?: boolean;
	effects?: Effect[];
}

export interface StickerClip extends BaseTimelineClip {
	type: "sticker";
	stickerId: string;
	/** Natural dimensions of the sticker projectItem, stored at insert time. Used by renderer and preview bounds to avoid split-brain geometry. */
	intrinsicWidth?: number;
	intrinsicHeight?: number;
	hidden?: boolean;
	effects?: Effect[];
}

export interface GraphicClip extends BaseTimelineClip {
	type: "graphic";
	definitionId: string;
	hidden?: boolean;
	effects?: Effect[];
	masks?: Mask[];
}

export interface EffectClip extends BaseTimelineClip {
	type: "effect";
	effectType: string;
}

export type ClipUpdatePatch = { params?: Partial<ParamValues> };

export type TimelineClip =
	| AudioClip
	| VideoClip
	| ImageClip
	| TextClip
	| StickerClip
	| GraphicClip
	| EffectClip;

export type ClipType = TimelineClip["type"];

function clipTypes<T extends ClipType[]>(...types: T): T {
	return types;
}

export const MASKABLE_CLIP_TYPES = clipTypes("video", "image", "graphic");

export type MaskableClip = Extract<
	TimelineClip,
	{ type: (typeof MASKABLE_CLIP_TYPES)[number] }
>;

export const RETIMABLE_CLIP_TYPES = clipTypes("video", "audio");

export type RetimableClip = Extract<
	TimelineClip,
	{ type: (typeof RETIMABLE_CLIP_TYPES)[number] }
>;

export const VISUAL_CLIP_TYPES = clipTypes(
	"video",
	"image",
	"text",
	"sticker",
	"graphic",
);

export type VisualClip = Extract<
	TimelineClip,
	{ type: (typeof VISUAL_CLIP_TYPES)[number] }
>;

export type CreateUploadAudioClip = Omit<UploadAudioClip, "id">;
export type CreateLibraryAudioClip = Omit<LibraryAudioClip, "id">;
export type CreateAudioClip = CreateUploadAudioClip | CreateLibraryAudioClip;
export type CreateVideoClip = Omit<VideoClip, "id">;
export type CreateImageClip = Omit<ImageClip, "id">;
export type CreateTextClip = Omit<TextClip, "id">;
export type CreateStickerClip = Omit<StickerClip, "id">;
export type CreateGraphicClip = Omit<GraphicClip, "id">;
export type CreateEffectClip = Omit<EffectClip, "id">;
export type CreateTimelineClip =
	| CreateAudioClip
	| CreateVideoClip
	| CreateImageClip
	| CreateTextClip
	| CreateStickerClip
	| CreateGraphicClip
	| CreateEffectClip;

export interface ClipDragState {
	isDragging: boolean;
	clipId: string | null;
	dragClipIds: string[];
	dragTimeOffsets: Record<string, MediaTime>;
	trackId: string | null;
	startMouseX: number;
	startMouseY: number;
	startClipTime: MediaTime;
	clickOffsetTime: MediaTime;
	currentTime: MediaTime;
	currentMouseY: number;
}

export type ClipDragView =
	| { readonly kind: "idle" }
	| {
			readonly kind: "dragging";
			readonly anchorClipId: string;
			readonly trackId: string;
			readonly memberTimeOffsets: ReadonlyMap<string, MediaTime>;
			readonly startMouseX: number;
			readonly startMouseY: number;
			readonly startClipTime: MediaTime;
			readonly clickOffsetTime: MediaTime;
			readonly currentTime: MediaTime;
			readonly currentMouseX: number;
			readonly currentMouseY: number;
			readonly dropTarget: DropTarget | null;
	  };

export interface DropTarget {
	trackIndex: number;
	isNewTrack: boolean;
	insertPosition: "above" | "below" | null;
	xPosition: MediaTime;
	targetClip: { clipId: string; trackId: string } | null;
}

export interface ComputeDropTargetParams {
	clipType: ClipType;
	mouseX: number;
	mouseY: number;
	tracks: SequenceTracks;
	playheadTime: MediaTime;
	isExternalDrop: boolean;
	clipDuration: MediaTime;
	pixelsPerSecond: number;
	zoomLevel: number;
	verticalDragDirection?: "up" | "down" | null;
	startTimeOverride?: MediaTime;
	excludeClipId?: string;
	targetClipTypes?: string[];
}

export interface ClipboardItem {
	trackId: string;
	trackType: TrackType;
	clip: CreateTimelineClip;
}
