"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { fetchStyleDefaults, oldestStyleRevision } from "@/agent/style-profile";
import { StyleUpdateApi, type StylePreview } from "@/agent/style-update";
import { readBridgeToken } from "@/bridge/token";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useEditor } from "@/editor/use-editor";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { calculateTotalDuration } from "@/timeline";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

export function StyleUpdateDialog() {
	const editor = useEditor();
	const current = useEditor((e) =>
		oldestStyleRevision({
			project: e.project.getActive(),
			sequences: e.sequences.getSequences(),
		}),
	);
	const api = useMemo(() => new StyleUpdateApi({ editor }), [editor]);
	const [latest, setLatest] = useState(0);
	const [preview, setPreview] = useState<StylePreview | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let active = true;
		const refresh = () => {
			if (!readBridgeToken()) return;
			void fetchStyleDefaults()
				.then(({ revision }) => {
					if (active) setLatest(revision);
				})
				.catch(() => {});
		};
		refresh();
		window.addEventListener("focus", refresh);
		const timer = window.setInterval(refresh, 10_000);
		return () => {
			active = false;
			window.clearInterval(timer);
			window.removeEventListener("focus", refresh);
		};
	}, []);

	const openPreview = async () => {
		setBusy(true);
		try {
			const next = await api.preview();
			if (next) {
				editor.playback.pause();
				setPreview(next);
			} else {
				setLatest(
					oldestStyleRevision({
						project: editor.project.getActive(),
						sequences: editor.sequences.getSequences(),
					}),
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not preview the style update.",
			);
		} finally {
			setBusy(false);
		}
	};

	const apply = async () => {
		if (!preview) return;
		setBusy(true);
		try {
			const result = await api.apply({
				request: { previewId: preview.id, expectedRevision: preview.revision },
			});
			setPreview(null);
			if (result.ok) {
				setLatest(result.styleRevision);
				toast.success("Project style updated");
			} else toast.error(result.message);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not update the style.",
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{latest > current && (
				<Button
					size="sm"
					variant="outline"
					onClick={openPreview}
					disabled={busy}
				>
					Update style
				</Button>
			)}
			<Dialog
				open={preview !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setPreview(null);
				}}
			>
				{preview && (
					<DialogContent className="max-w-4xl max-h-[90dvh] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>Update project style</DialogTitle>
							<DialogDescription>
								Defaults {preview.from} → {preview.defaults.revision}
							</DialogDescription>
						</DialogHeader>
						<StyleComparison key={preview.id} preview={preview} />
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => setPreview(null)}
								disabled={busy}
							>
								Cancel
							</Button>
							<Button onClick={apply} disabled={busy}>
								Apply style update
							</Button>
						</DialogFooter>
					</DialogContent>
				)}
			</Dialog>
		</>
	);
}

function StyleComparison({ preview }: { preview: StylePreview }) {
	const editor = useEditor();
	const options = useMemo(
		() =>
			preview.sequences.flatMap((sequence) =>
				sequence.changes.map((change) => ({ sequence, change })),
			),
		[preview],
	);
	const [selected, setSelected] = useState(0);
	const [offset, setOffset] = useState<number | null>(null);
	const option = options[selected];
	const beforeCanvas = useRef<HTMLCanvasElement>(null);
	const afterCanvas = useRef<HTMLCanvasElement>(null);
	const generation = useRef<Promise<void>>(Promise.resolve());
	const [frame, setFrame] = useState<{ key: string; error?: string } | null>(
		null,
	);
	const time = offset ?? option?.change.time ?? 0;
	const key = `${selected}:${time}`;
	const duration = option
		? Math.max(
				...[option.sequence.before, option.sequence.after].map(({ tracks }) =>
					mediaTimeToSeconds({ time: calculateTotalDuration({ tracks }) }),
				),
			)
		: 0;
	const settings = editor.project.getActive().settings;
	const ratio = settings.canvasSize.width / settings.canvasSize.height;
	const width = Math.min(440, Math.round(300 * ratio));
	const height = Math.round(width / ratio);

	useEffect(() => {
		const before = beforeCanvas.current;
		const after = afterCanvas.current;
		if (!option || !before || !after) return;
		let obsolete = false;
		const projectItems = editor.media.getProjectItems();
		generation.current = generation.current.then(async () => {
			if (obsolete) return;
			try {
				await editor.renderer.compareFrames(async () => {
					const renderer = new CanvasRenderer({
						...settings.canvasSize,
						fps: settings.fps,
					});
					for (const { sequence, targetCanvas } of [
						{ sequence: option.sequence.before, targetCanvas: before },
						{ sequence: option.sequence.after, targetCanvas: after },
					]) {
						if (obsolete) return;
						const node = buildScene({
							tracks: sequence.tracks,
							projectItems,
							duration: mediaTimeFromSeconds({ seconds: duration }),
							canvasSize: settings.canvasSize,
							background: settings.background,
						});
						await renderer.renderToCanvas({
							node,
							time: mediaTimeFromSeconds({ seconds: time }),
							targetCanvas,
						});
					}
				});
				if (!obsolete) setFrame({ key });
			} catch (error) {
				if (!obsolete)
					setFrame({
						key,
						error: error instanceof Error ? error.message : "Frame unavailable",
					});
			}
		});
		return () => {
			obsolete = true;
		};
	}, [duration, editor, key, option, settings, time]);

	if (!option)
		return (
			<DialogBody>
				<p className="text-sm">
					The current graphics and captions have no visible changes.
				</p>
			</DialogBody>
		);

	return (
		<DialogBody>
			<div className="grid grid-cols-2 gap-3">
				{[
					{ label: "Current", ref: beforeCanvas },
					{ label: "Updated", ref: afterCanvas },
				].map(({ label, ref }) => (
					<figure
						key={label}
						className="bg-background grid content-start justify-items-center overflow-hidden rounded-md border p-2"
					>
						<canvas
							ref={ref}
							width={width}
							height={height}
							className="max-w-full h-auto bg-black"
							aria-label={`${label} frame`}
						/>
						<figcaption className="text-muted-foreground pt-2 text-xs">
							{label}
						</figcaption>
					</figure>
				))}
			</div>
			<label className="flex items-center gap-3 text-sm">
				Preview time
				<input
					type="range"
					className="min-w-0 flex-1"
					min={0}
					max={Math.max(0, duration - 0.001)}
					step="any"
					value={time}
					onChange={(event) => setOffset(event.currentTarget.valueAsNumber)}
				/>
				<output className="tabular-nums">{time.toFixed(2)} s</output>
			</label>
			<p className="text-muted-foreground text-xs" role="status">
				{frame?.key !== key
					? "Rendering comparison…"
					: (frame.error ?? "Frames ready")}
			</p>
			<div
				className="max-h-40 overflow-y-auto rounded-md border"
				aria-label="Affected clips"
			>
				{options.map(({ sequence, change }, index) => (
					<button
						key={`${sequence.before.id}:${change.id}`}
						type="button"
						aria-pressed={selected === index}
						className="hover:bg-muted aria-pressed:bg-accent block w-full border-b p-2.5 text-left text-sm last:border-b-0"
						onClick={() => {
							setSelected(index);
							setOffset(null);
						}}
					>
						<span className="font-medium">
							{sequence.before.name} / {change.clip}
						</span>
						<span className="text-muted-foreground block text-xs">
							{change.properties.join(", ")}
						</span>
					</button>
				))}
			</div>
		</DialogBody>
	);
}
