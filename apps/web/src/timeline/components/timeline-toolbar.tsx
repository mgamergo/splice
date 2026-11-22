import { useEditor } from "@/editor/use-editor";
import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import {
	TooltipProvider,
	Tooltip,
	TooltipTrigger,
	TooltipContent,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
	SplitButton,
	SplitButtonLeft,
	SplitButtonRight,
	SplitButtonSeparator,
} from "@/components/ui/split-button";
import { Slider } from "@/components/ui/slider";
import { TIMELINE_ZOOM_BUTTON_FACTOR } from "./interaction";
import { TIMELINE_ZOOM_MAX } from "@/timeline/scale";
import { sliderToZoom, zoomToSlider } from "@/timeline/zoom-utils";
import { SequencesView } from "@/components/editor/sequences-view";
import { type TActionWithOptionalArgs, invokeAction } from "@/actions";
import {
	canToggleSourceAudio,
	getSourceAudioActionLabel,
	isSourceAudioSeparated,
} from "@/timeline/audio-separation";
import { hasMediaId } from "@/timeline";
import { cn } from "@/utils/ui";
import { useTimelineStore } from "@/timeline/timeline-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Bookmark02Icon,
	Delete02Icon,
	SnowIcon,
	ScissorIcon,
	MagnetIcon,
	SearchAddIcon,
	SearchMinusIcon,
	Copy01Icon,
	AlignLeftIcon,
	AlignRightIcon,
	Link02Icon,
	Layers01Icon,
	Chart03Icon,
	Unlink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OcRippleIcon } from "@/components/icons";
import { GraphEditorPopover } from "./graph-editor/popover";
import { PopoverTrigger } from "@/components/ui/popover";
import { useGraphEditorController } from "./graph-editor/use-controller";

export function TimelineToolbar({
	zoomLevel,
	minZoom,
	setZoomLevel,
}: {
	zoomLevel: number;
	minZoom: number;
	setZoomLevel: ({ zoom }: { zoom: number }) => void;
}) {
	const handleZoom = ({ direction }: { direction: "in" | "out" }) => {
		const newZoomLevel =
			direction === "in"
				? Math.min(TIMELINE_ZOOM_MAX, zoomLevel * TIMELINE_ZOOM_BUTTON_FACTOR)
				: Math.max(minZoom, zoomLevel / TIMELINE_ZOOM_BUTTON_FACTOR);
		setZoomLevel({ zoom: newZoomLevel });
	};

	return (
		<ScrollArea className="scrollbar-hidden">
			<div className="flex h-10 items-center justify-between border-b px-2 py-1">
				<ToolbarLeftSection />

				<SequenceSelector />

				<ToolbarRightSection
					zoomLevel={zoomLevel}
					minZoom={minZoom}
					onZoomChange={(zoom) => setZoomLevel({ zoom })}
					onZoom={handleZoom}
				/>
			</div>
		</ScrollArea>
	);
}

function ToolbarLeftSection() {
	const editor = useEditor();
	const projectItems = useEditor((currentEditor) =>
		currentEditor.media.getProjectItems(),
	);
	const { selectedClips } = useClipSelection();
	const graphEditor = useGraphEditorController();
	const isCurrentlyMarkered = useEditor((e) =>
		e.sequences.isMarkered({ time: e.playback.getCurrentTime() }),
	);
	const selectedClip =
		selectedClips.length === 1
			? (editor.timeline.getClipsWithTracks({
					clips: selectedClips,
				})[0] ?? null)
			: null;
	const selectedProjectItem = (() => {
		if (!selectedClip) {
			return null;
		}

		const { clip } = selectedClip;
		if (!hasMediaId(clip)) {
			return null;
		}

		return projectItems.find((projectItem) => projectItem.id === clip.mediaId) ?? null;
	})();
	const canToggleSelectedSourceAudio =
		!!selectedClip &&
		canToggleSourceAudio(selectedClip.clip, selectedProjectItem);
	const sourceAudioLabel =
		selectedClip?.clip.type === "video"
			? getSourceAudioActionLabel({
					clip: selectedClip.clip,
				})
			: "Extract audio";
	const isSelectedSourceAudioSeparated =
		selectedClip?.clip.type === "video" &&
		isSourceAudioSeparated({
			clip: selectedClip.clip,
		});

	const handleAction = ({
		action,
		event,
	}: {
		action: TActionWithOptionalArgs;
		event: React.MouseEvent;
	}) => {
		event.stopPropagation();
		invokeAction(action);
	};

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={ScissorIcon} />}
					tooltip="Razor"
					onClick={({ event }) => handleAction({ action: "razor", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignLeftIcon} />}
					tooltip="Razor left"
					onClick={({ event }) => handleAction({ action: "razor-left", event })}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={AlignRightIcon} />}
					tooltip="Razor right"
					onClick={({ event }) =>
						handleAction({ action: "razor-right", event })
					}
				/>

				<ToolbarButton
					icon={
						<HugeiconsIcon
							icon={isSelectedSourceAudioSeparated ? Unlink02Icon : Link02Icon}
						/>
					}
					tooltip={sourceAudioLabel}
					disabled={!canToggleSelectedSourceAudio}
					onClick={({ event }) =>
						handleAction({ action: "toggle-source-audio", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Copy01Icon} />}
					tooltip="Duplicate clip"
					onClick={({ event }) =>
						handleAction({ action: "duplicate-selected", event })
					}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={SnowIcon} />}
					tooltip="Freeze frame (coming soon)"
					disabled={true}
					onClick={({ event: _event }) => {}}
				/>

				<ToolbarButton
					icon={<HugeiconsIcon icon={Delete02Icon} />}
					tooltip="Delete clip"
					onClick={({ event }) =>
						handleAction({ action: "delete-selected", event })
					}
				/>

				<div className="bg-border mx-1 h-6 w-px" />

				<Tooltip>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Bookmark02Icon} />}
						isActive={isCurrentlyMarkered}
						tooltip={isCurrentlyMarkered ? "Remove marker" : "Add marker"}
						onClick={({ event }) =>
							handleAction({ action: "toggle-marker", event })
						}
					/>
				</Tooltip>

				<GraphEditorPopover
					open={graphEditor.open}
					onOpenChange={graphEditor.onOpenChange}
					value={
						graphEditor.state.status === "ready"
							? graphEditor.state.cubicBezier
							: null
					}
					message={graphEditor.state.message}
					componentOptions={graphEditor.state.componentOptions}
					activeComponentKey={graphEditor.state.activeComponentKey}
					onActiveComponentKeyChange={graphEditor.onActiveComponentKeyChange}
					onPreviewValue={graphEditor.onPreviewValue}
					onCommitValue={graphEditor.onCommitValue}
					onCancelPreview={graphEditor.onCancelPreview}
				>
					<ToolbarButton
						icon={<HugeiconsIcon icon={Chart03Icon} />}
						tooltip={graphEditor.tooltip}
						disabled={!graphEditor.canOpen}
						buttonWrapper={(button) =>
							graphEditor.canOpen ? (
								<PopoverTrigger asChild>{button}</PopoverTrigger>
							) : (
								button
							)
						}
					/>
				</GraphEditorPopover>
			</TooltipProvider>
		</div>
	);
}

function SequenceSelector() {
	const editor = useEditor();
	const currentSequence = editor.sequences.getActiveSequence();

	return (
		<div>
			<SplitButton className="border-foreground/10 border">
				<SplitButtonLeft>{currentSequence?.name || "No Sequence"}</SplitButtonLeft>
				<SplitButtonSeparator />
				<SequencesView>
					<SplitButtonRight onClick={() => {}}>
						<HugeiconsIcon icon={Layers01Icon} className="size-4" />
					</SplitButtonRight>
				</SequencesView>
			</SplitButton>
		</div>
	);
}

function ToolbarRightSection({
	zoomLevel,
	minZoom,
	onZoomChange,
	onZoom,
}: {
	zoomLevel: number;
	minZoom: number;
	onZoomChange: (zoom: number) => void;
	onZoom: (options: { direction: "in" | "out" }) => void;
}) {
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	const rippleEditingEnabled = useTimelineStore((s) => s.rippleEditingEnabled);
	const toggleSnapping = useTimelineStore((s) => s.toggleSnapping);
	const toggleRippleEditing = useTimelineStore((s) => s.toggleRippleEditing);

	return (
		<div className="flex items-center gap-1">
			<TooltipProvider delayDuration={500}>
				<ToolbarButton
					icon={<HugeiconsIcon icon={MagnetIcon} />}
					isActive={snappingEnabled}
					tooltip="Auto snapping"
					onClick={() => toggleSnapping()}
				/>

				<ToolbarButton
					icon={<OcRippleIcon size={24} className="scale-110" />}
					isActive={rippleEditingEnabled}
					tooltip="Ripple editing"
					onClick={() => toggleRippleEditing()}
				/>
			</TooltipProvider>

			<div className="bg-border mx-1 h-6 w-px" />

			<div className="flex items-center gap-1">
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "out" })}
				>
					<HugeiconsIcon icon={SearchMinusIcon} />
				</Button>
				<Slider
					className="w-28"
					value={[zoomToSlider({ zoomLevel, minZoom })]}
					onValueChange={(values) =>
						onZoomChange(sliderToZoom({ sliderPosition: values[0], minZoom }))
					}
					min={0}
					max={1}
					step={0.005}
				/>
				<Button
					variant="text"
					size="icon"
					onClick={() => onZoom({ direction: "in" })}
				>
					<HugeiconsIcon icon={SearchAddIcon} />
				</Button>
			</div>
		</div>
	);
}

function ToolbarButton({
	icon,
	tooltip,
	onClick,
	disabled,
	isActive,
	buttonWrapper,
}: {
	icon: React.ReactNode;
	tooltip: string;
	onClick?: ({ event }: { event: React.MouseEvent }) => void;
	disabled?: boolean;
	isActive?: boolean;
	buttonWrapper?: (button: React.ReactElement) => React.ReactElement;
}) {
	const button = (
		<Button
			variant={isActive ? "secondary" : "text"}
			size="icon"
			disabled={disabled}
			onClick={onClick ? (event) => onClick({ event }) : undefined}
			className={cn(
				"rounded-sm",
				disabled ? "cursor-not-allowed opacity-50" : "",
			)}
		>
			{icon}
		</Button>
	);
	const trigger = disabled ? (
		<span className="inline-flex">{button}</span>
	) : buttonWrapper ? (
		buttonWrapper(button)
	) : (
		button
	);

	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{trigger}</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
