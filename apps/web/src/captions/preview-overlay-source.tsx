import {
	EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
	type PreviewOverlayDefinition,
	type PreviewOverlaySourceResult,
} from "@/preview/overlays";
import { cn } from "@/utils/ui";
import { type CaptionCue, wrapCueText } from "./cues";

export const captionsPreviewOverlay: PreviewOverlayDefinition = {
	id: "captions",
	label: "Show captions",
	defaultVisible: true,
};

/**
 * Shows the cue at the playhead over the preview, the way a player shows an
 * SRT. It is never drawn into the export. Clicking it selects the cue.
 */
export function getCaptionPreviewOverlaySource({
	cue,
	isVisible,
	isSelected,
	onSelect,
}: {
	cue: CaptionCue | undefined;
	isVisible: boolean;
	isSelected: boolean;
	onSelect: (cue: CaptionCue) => void;
}): PreviewOverlaySourceResult {
	if (!isVisible || !cue)
		return {
			...EMPTY_PREVIEW_OVERLAY_SOURCE_RESULT,
			definitions: [captionsPreviewOverlay],
		};
	return {
		definitions: [captionsPreviewOverlay],
		instances: [
			{
				id: captionsPreviewOverlay.id,
				mount: { kind: "scene" },
				plane: "over-interaction",
				pointerEvents: "none",
				render: ({ sceneHeight }) => (
					<div className="flex size-full items-end justify-center px-[6%] pb-[5%]">
						<button
							type="button"
							data-caption-cue={cue.id}
							aria-label={`Caption ${cue.index}: ${cue.text}. Select to correct it.`}
							onClick={() => onSelect(cue)}
							className={cn(
								"pointer-events-auto max-w-full cursor-pointer rounded-sm bg-black/75 px-[0.6em] py-[0.15em] text-center leading-snug font-medium whitespace-pre-line text-white outline-offset-2",
								isSelected && "outline-primary outline-2",
							)}
							style={{ fontSize: Math.max(10, sceneHeight * 0.045) }}
						>
							{wrapCueText(cue.text)}
						</button>
					</div>
				),
			},
		],
	};
}
