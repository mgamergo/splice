import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextClip } from "@/timeline/clip-utils";
import type { MediaTime } from "@/wasm";

export function TextView() {
	const editor = useEditor();

	const handleAddToTimeline = ({ currentTime }: { currentTime: MediaTime }) => {
		const activeSequence = editor.sequences.getActiveSequence();
		if (!activeSequence) return;

		const clip = buildTextClip({
			raw: DEFAULTS.text.clip,
			startTime: currentTime,
		});

		editor.timeline.insertClip({
			clip,
			placement: { mode: "auto" },
		});
	};

	return (
		<PanelView title="Text">
			<DraggableItem
				name="Default text"
				preview={
					<div className="bg-accent flex size-full items-center justify-center rounded">
						<span className="text-xs select-none">Default text</span>
					</div>
				}
				dragData={{
					id: "temp-text-id",
					type: DEFAULTS.text.clip.type,
					name: DEFAULTS.text.clip.name,
					content: "Default text",
				}}
				aspectRatio={1}
				onAddToTimeline={handleAddToTimeline}
				shouldShowLabel={false}
			/>
		</PanelView>
	);
}
