"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEditor } from "@/editor/use-editor";
import { useClipSelection } from "@/timeline/hooks/clip/use-clip-selection";
import { usePropertiesStore } from "./stores/properties-store";
import { getPropertiesConfig } from "./registry";
import { cn } from "@/utils/ui";
import { GraphicEvidence, UnplacedGraphics } from "./components/graphic-evidence";
import { EmptyView } from "./empty-view";

export function PropertiesPanel() {
	const editor = useEditor();
	const sequence = useEditor((e) => e.sequences.getActiveSequenceOrNull());
	useEditor((e) => e.media.getProjectItems());
	const { selectedClips } = useClipSelection();
	const { activeTabPerType, setActiveTab } = usePropertiesStore();

	if (selectedClips.length === 0) {
		const unplaced = sequence?.graphics?.records.filter(({ placed }) => !placed) ?? [];
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				{unplaced.length > 0 ? <UnplacedGraphics graphics={unplaced} /> : <EmptyView />}
			</div>
		);
	}

	if (selectedClips.length > 1) {
		return (
			<div className="panel bg-background flex h-full flex-col items-center justify-center overflow-hidden rounded-sm border">
				<p className="text-muted-foreground text-sm">
					{selectedClips.length} clips selected.0
				</p>
			</div>
		);
	}

	const projectItems = editor.media.getProjectItems();

	const clipsWithTracks = editor.timeline.getClipsWithTracks({
		clips: selectedClips,
	});
	const clipWithTrack = clipsWithTracks[0];

	if (!clipWithTrack) return null;

	const { clip, track } = clipWithTrack;
	const graphic = sequence?.graphics?.records.find(({ id }) => id === clip.graphicId);
	const config = getPropertiesConfig({ clip, projectItems });
	const visibleTabs = config.tabs;

	const storedTabId = activeTabPerType[clip.type];
	const isStoredTabVisible = visibleTabs.some((t) => t.id === storedTabId);
	const activeTabId = isStoredTabVisible ? storedTabId : config.defaultTab;
	const activeTab =
		visibleTabs.find((t) => t.id === activeTabId) ?? visibleTabs[0];

	if (!activeTab) return null;

	return (
		<div className="panel bg-background flex h-full overflow-hidden rounded-sm border">
			<TooltipProvider delayDuration={0}>
				<div className="flex shrink-0 flex-col gap-0.5 border-r p-1 scrollbar-hidden overflow-y-auto">
					{visibleTabs.map((tab) => (
						<Tooltip key={tab.id}>
							<TooltipTrigger asChild>
								<Button
									variant={tab.id === activeTab.id ? "secondary" : "ghost"}
									size="icon"
									onClick={() =>
										setActiveTab({
											clipType: clip.type,
											tabId: tab.id,
										})
									}
									aria-label={tab.label}
									className={cn(
										"shrink-0",
										"h-8 w-8",
										tab.id !== activeTab.id && "text-muted-foreground",
									)}
								>
									{tab.icon}
								</Button>
							</TooltipTrigger>
							<TooltipContent side="right">{tab.label}</TooltipContent>
						</Tooltip>
					))}
				</div>
			</TooltipProvider>
			<ScrollArea className="flex-1 scrollbar-hidden">
				{graphic && (
					<>
						<GraphicEvidence graphic={graphic} />
						{graphic.flags.map(({ code, message }) => (
							<p key={code} className="border-b p-3 text-sm text-muted-foreground">{message}</p>
						))}
					</>
				)}
				{activeTab.content({ trackId: track.id })}
			</ScrollArea>
		</div>
	);
}
