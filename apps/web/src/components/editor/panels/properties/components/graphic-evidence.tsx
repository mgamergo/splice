import type { GraphicRecord } from "@splice/bridge/graphics";
import { deleteGraphic, locateSourceTime } from "@/agent/graphics";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { mediaTimeFromSeconds } from "@/wasm";

export function GraphicEvidence({ graphic }: { graphic: GraphicRecord }) {
	const editor = useEditor();
	const sequence = editor.sequences.getActiveSequence();
	const items = editor.media.getProjectItems();
	const recordingName = (id: string) =>
		items.find((item) => item.id === id)?.name ?? id;
	const anchor = locateSourceTime({
		tracks: sequence.tracks,
		projectItemId: graphic.action.projectItemId,
		sourceTime: graphic.action.time,
		near: graphic.placed?.anchor,
	});
	const target = graphic.target;
	const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

	return (
		<details className="border-b p-3 text-sm">
			<summary className="cursor-pointer font-medium">Graphic evidence</summary>
			<dl className="mt-2 space-y-2 text-muted-foreground">
				<div>
					<dt className="font-medium text-foreground">Spoken passage</dt>
					<dd>
						{recordingName(graphic.passage.projectItemId)} ·{" "}
						{graphic.passage.start.toFixed(2)}–{graphic.passage.end.toFixed(2)}{" "}
						s
					</dd>
					{graphic.passage.text && <dd>{graphic.passage.text}</dd>}
				</div>
				<div>
					<dt className="font-medium text-foreground">Source frame</dt>
					<dd>
						{recordingName(graphic.action.projectItemId)} ·{" "}
						{graphic.action.time.toFixed(2)} s
					</dd>
				</div>
				{target && (
					<div>
						<dt className="font-medium text-foreground">Target rectangle</dt>
						<dd>
							{percent(target.width)} × {percent(target.height)} at{" "}
							{percent(target.x)} from left, {percent(target.y)} from top
						</dd>
					</div>
				)}
			</dl>
			{anchor && (
				<Button
					className="mt-2"
					size="sm"
					variant="outline"
					onClick={() =>
						editor.playback.seek({
							time: mediaTimeFromSeconds({ seconds: anchor.time }),
						})
					}
				>
					Go to action
				</Button>
			)}
		</details>
	);
}

export function UnplacedGraphics({ graphics }: { graphics: GraphicRecord[] }) {
	const editor = useEditor();
	return (
		<section className="w-full overflow-y-auto p-3 text-sm">
			<h2 className="font-medium">Graphics to review</h2>
			{graphics.map((graphic) => (
				<div key={graphic.id} className="mt-3 border-b pb-2">
					<p className="capitalize">{graphic.kind}</p>
					{graphic.flags.map(({ code, message }) => (
						<p key={code} className="text-muted-foreground">
							{message}
						</p>
					))}
					<GraphicEvidence graphic={graphic} />
					<Button
						className="mt-2"
						size="sm"
						variant="outline"
						onClick={() => {
							const sequence = editor.sequences.getActiveSequence();
							const updates = deleteGraphic({
								sequence,
								graphicId: graphic.id,
							});
							if (!updates) return;
							editor.command.execute({
								command: new UpdateSequenceCommand({
									editor,
									sequenceId: sequence.id,
									updates,
									label: "Delete graphic",
								}),
							});
						}}
					>
						Delete graphic
					</Button>
				</div>
			))}
		</section>
	);
}
