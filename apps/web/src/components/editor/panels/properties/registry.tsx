import type { ReactNode } from "react";
import type {
	EffectClip,
	GraphicClip,
	ImageClip,
	MaskableClip,
	RetimableClip,
	StickerClip,
	TextClip,
	VisualClip,
	VideoClip,
	AudioClip,
	TimelineClip,
} from "@/timeline";
import type { ProjectItem } from "@/media/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	TextFontIcon,
	ArrowExpandIcon,
	RainDropIcon,
	MusicNote03Icon,
	MagicWand05Icon,
	DashboardSpeed02Icon,
} from "@hugeicons/core-free-icons";
import { ClipParamsTab } from "./components/clip-params-tab";
import { ClipEffectsTab, StandaloneEffectTab } from "@/effects/components/effects-tab";
import { MasksTab } from "@/masks/components/masks-tab";
import { SpeedTab } from "@/speed/components/speed-tab";
import { GraphicTab } from "@/graphics/components/graphic-tab";
import { OcShapesIcon } from "@/components/icons";

const TRANSFORM_PARAM_KEYS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
] as const;

const BLENDING_PARAM_KEYS = ["opacity", "blendMode"] as const;
const AUDIO_PARAM_KEYS = ["volume", "muted"] as const;
const TEXT_PARAM_KEYS = [
	"content",
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
] as const;

export type TabContentProps = {
	trackId: string;
};

export type PropertiesTabDef = {
	id: string;
	label: string;
	icon: ReactNode;
	content: (props: TabContentProps) => ReactNode;
};

export type ClipPropertiesConfig = {
	defaultTab: string;
	tabs: PropertiesTabDef[];
};

function buildTransformTab({
	clip,
}: {
	clip: VisualClip;
}): PropertiesTabDef {
	return {
		id: "transform",
		label: "Transform",
		icon: <HugeiconsIcon icon={ArrowExpandIcon} size={16} />,
		content: ({ trackId }) => (
			<ClipParamsTab
				clip={clip}
				trackId={trackId}
				paramKeys={TRANSFORM_PARAM_KEYS}
				sectionKey="transform"
			/>
		),
	};
}

function buildBlendingTab({
	clip,
}: {
	clip: VisualClip;
}): PropertiesTabDef {
	return {
		id: "blending",
		label: "Blending",
		icon: <HugeiconsIcon icon={RainDropIcon} size={16} />,
		content: ({ trackId }) => (
			<ClipParamsTab
				clip={clip}
				trackId={trackId}
				paramKeys={BLENDING_PARAM_KEYS}
				sectionKey="blending"
			/>
		),
	};
}

function buildAudioTab({
	clip,
}: {
	clip: AudioClip | VideoClip;
}): PropertiesTabDef {
	return {
		id: "audio",
		label: "Audio",
		icon: <HugeiconsIcon icon={MusicNote03Icon} size={16} />,
		content: ({ trackId }) => (
			<ClipParamsTab
				clip={clip}
				trackId={trackId}
				paramKeys={AUDIO_PARAM_KEYS}
				sectionKey="audio"
			/>
		),
	};
}

function buildSpeedTab({
	clip,
}: {
	clip: RetimableClip;
}): PropertiesTabDef {
	return {
		id: "speed",
		label: "Speed",
		icon: <HugeiconsIcon icon={DashboardSpeed02Icon} size={16} />,
		content: ({ trackId }) => <SpeedTab clip={clip} trackId={trackId} />,
	};
}

function buildMasksTab({
	clip,
}: {
	clip: MaskableClip;
}): PropertiesTabDef {
	return {
		id: "masks",
		label: "Masks",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) => <MasksTab clip={clip} trackId={trackId} />,
	};
}

function buildClipEffectsTab({
	clip,
}: {
	clip: VisualClip;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<ClipEffectsTab clip={clip} trackId={trackId} />
		),
	};
}

function buildTextTab({ clip }: { clip: TextClip }): PropertiesTabDef {
	return {
		id: "text",
		label: "Text",
		icon: <HugeiconsIcon icon={TextFontIcon} size={16} />,
		content: ({ trackId }) => (
			<ClipParamsTab
				clip={clip}
				trackId={trackId}
				paramKeys={TEXT_PARAM_KEYS}
				sectionKey="text"
			/>
		),
	};
}

function buildGraphicTab({
	clip,
}: {
	clip: GraphicClip;
}): PropertiesTabDef {
	return {
		id: "graphic",
		label: "Graphic",
		icon: <OcShapesIcon size={16} />,
		content: ({ trackId }) => <GraphicTab clip={clip} trackId={trackId} />,
	};
}

function buildStandaloneEffectTab({
	clip,
}: {
	clip: EffectClip;
}): PropertiesTabDef {
	return {
		id: "effects",
		label: "Effects",
		icon: <HugeiconsIcon icon={MagicWand05Icon} size={16} />,
		content: ({ trackId }) => (
			<StandaloneEffectTab clip={clip} trackId={trackId} />
		),
	};
}

function getTextConfig({
	clip,
}: {
	clip: TextClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "text",
		tabs: [
			buildTextTab({ clip }),
			buildTransformTab({ clip }),
			buildBlendingTab({ clip }),
		],
	};
}

function getVideoConfig({
	clip,
	projectItem,
}: {
	clip: VideoClip;
	projectItem: ProjectItem | undefined;
}): ClipPropertiesConfig {
	const showAudioTab = projectItem?.hasAudio !== false;
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ clip }),
			...(showAudioTab ? [buildAudioTab({ clip })] : []),
			buildSpeedTab({ clip }),
			buildBlendingTab({ clip }),
			buildMasksTab({ clip }),
			buildClipEffectsTab({ clip }),
		],
	};
}

function getImageConfig({
	clip,
}: {
	clip: ImageClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ clip }),
			buildBlendingTab({ clip }),
			buildMasksTab({ clip }),
			buildClipEffectsTab({ clip }),
		],
	};
}

function getStickerConfig({
	clip,
}: {
	clip: StickerClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "transform",
		tabs: [
			buildTransformTab({ clip }),
			buildBlendingTab({ clip }),
			buildClipEffectsTab({ clip }),
		],
	};
}

function getGraphicConfig({
	clip,
}: {
	clip: GraphicClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "graphic",
		tabs: [
			buildGraphicTab({ clip }),
			buildTransformTab({ clip }),
			buildBlendingTab({ clip }),
			buildMasksTab({ clip }),
			buildClipEffectsTab({ clip }),
		],
	};
}

function getAudioConfig({
	clip,
}: {
	clip: AudioClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "audio",
		tabs: [buildAudioTab({ clip }), buildSpeedTab({ clip })],
	};
}

function getEffectConfig({
	clip,
}: {
	clip: EffectClip;
}): ClipPropertiesConfig {
	return {
		defaultTab: "effects",
		tabs: [buildStandaloneEffectTab({ clip })],
	};
}

export function getPropertiesConfig({
	clip,
	projectItems,
}: {
	clip: TimelineClip;
	projectItems: ProjectItem[];
}): ClipPropertiesConfig {
	switch (clip.type) {
		case "text":
			return getTextConfig({ clip });
		case "video": {
			const projectItem = projectItems.find((a) => a.id === clip.mediaId);
			return getVideoConfig({ clip, projectItem });
		}
		case "image":
			return getImageConfig({ clip });
		case "sticker":
			return getStickerConfig({ clip });
		case "graphic":
			return getGraphicConfig({ clip });
		case "audio":
			return getAudioConfig({ clip });
		case "effect":
			return getEffectConfig({ clip });
	}
}
