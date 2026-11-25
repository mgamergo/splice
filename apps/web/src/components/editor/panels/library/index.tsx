"use client";

import { Separator } from "@/components/ui/separator";
import { type Tab, useLibraryPanelStore } from "@/components/editor/panels/library/library-panel-store";
import { TabBar } from "./tabbar";
import { Captions } from "@/subtitles/components/library-view";
import { CaptionList } from "@/captions/components/caption-list";
import { TranscriptPanel } from "@/cut-transcript/components/transcript-panel";
import { useEditor } from "@/editor/use-editor";
import { projectFormat } from "@/project/format";
import { MediaView } from "./views/project-items";
import { SettingsView } from "./views/settings";
import { SoundsView } from "@/sounds/components/library-view";
import { StickersView } from "@/stickers/components/library-view";
import { TextView } from "@/text/components/library-view";
import { EffectsView } from "@/effects/components/library-view";

export function LibraryPanel() {
	const { activeTab } = useLibraryPanelStore();
	// Horizontal video ships SRT captions; Shorts burn them in.
	const isHorizontal = useEditor((e) => {
		const project = e.project.getActiveOrNull();
		return !!project && projectFormat({ project }) === "horizontal";
	});

	const viewMap: Record<Tab, React.ReactNode> = {
		media: <MediaView />,
		sounds: <SoundsView />,
		text: <TextView />,
		stickers: <StickersView />,
		effects: <EffectsView />,
		transitions: (
			<div className="text-muted-foreground p-4">
				Transitions view coming soon...
			</div>
		),
		captions: isHorizontal ? <CaptionList /> : <Captions />,
		transcript: <TranscriptPanel />,
		adjustment: (
			<div className="text-muted-foreground p-4">
				Adjustment view coming soon...
			</div>
		),
		settings: <SettingsView />,
	};

	return (
		<div className="panel bg-background flex h-full rounded-sm border overflow-hidden">
			<TabBar />
			<Separator orientation="vertical" />
			<div className="flex-1 overflow-hidden">{viewMap[activeTab]}</div>
		</div>
	);
}
