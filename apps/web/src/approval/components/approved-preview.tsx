"use client";

import { useEffect, useRef, useState } from "react";
import { playCue } from "@/captions/project-captions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { AudioManager } from "@/core/managers/audio-manager";
import { PlaybackManager } from "@/core/managers/playback-manager";
import { useEditor } from "@/editor/use-editor";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { VideoCache } from "@/services/video-cache/service";
import { checkpointSequence } from "../checkpoint";
import { calculateTotalDuration } from "@/timeline";
import {
	lastFrameMediaTime,
	mediaTimeToSeconds,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { passageWithContext, useApprovalViewStore } from "../playback";
import type { ApprovedCheckpoint } from "../types";

const subscribe = () => () => {};

export function ApprovedPreview() {
	const preview = useApprovalViewStore((state) => state.preview);
	const setPreview = useApprovalViewStore((state) => state.setPreview);
	useEffect(() => () => setPreview(null), [setPreview]);
	if (!preview) return null;

	return (
		<Dialog open onOpenChange={(open) => !open && setPreview(null)}>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>
						Approved cut · {preview.checkpoint.sequenceName}
					</DialogTitle>
					<DialogDescription>
						Approved {new Date(preview.checkpoint.approvedAt).toLocaleString()}
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Playback {...preview} />
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function Playback({
	checkpoint,
	passage,
}: {
	checkpoint: ApprovedCheckpoint;
	passage?: { start: number; end: number };
}) {
	const editor = useEditor();
	const canvasMountRef = useRef<HTMLDivElement>(null);
	const playbackRef = useRef<PlaybackManager | null>(null);
	const [playing, setPlaying] = useState(false);
	const [caption, setCaption] = useState("");
	const [error, setError] = useState<string | null>(null);
	const { canvasSize, fps } = editor.project.getActive().settings;
	const { width, height } = canvasSize;

	useEffect(() => {
		const mount = canvasMountRef.current;
		if (!mount) return;
		const sequence = checkpointSequence(checkpoint);
		const { tracks } = sequence;
		const duration = calculateTotalDuration({ tracks });
		if (duration <= 0) return;
		const projectItems = editor.media.getProjectItems();
		const timeline = { getTotalDuration: () => duration, subscribe };
		const sequences = {
			getActiveSequence: () => sequence,
			getActiveSequenceOrNull: () => sequence,
			subscribe,
		};
		const project = editor.project.getActive();
		const approvedProject = { ...project, captions: checkpoint.captions };
		const playback = new PlaybackManager({
			timeline,
			sequences,
			project: { getActive: () => approvedProject },
			audio: {
				prepareFinalPreview: (
					options,
				): ReturnType<AudioManager["prepareFinalPreview"]> =>
					audio.prepareFinalPreview(options),
			},
		});
		const controller = new AbortController();
		const videoCache = new VideoCache({ signal: controller.signal });
		const renderer = new CanvasRenderer({ width, height, fps, videoCache });
		const tree = buildScene({
			tracks,
			projectItems,
			duration,
			canvasSize: { width, height },
			background: checkpoint.background,
			isPreview: true,
		});
		let canvas: HTMLCanvasElement;
		try {
			canvas = renderer.getOutputCanvas();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
			return;
		}
		const audio = new AudioManager({
			playback,
			project: { getActiveOrNull: () => approvedProject },
			timeline,
			sequences,
			media: {
				getProjectItems: () => projectItems,
				subscribe,
			},
		});
		const unsubscribe = playback.subscribe(() =>
			setPlaying(playback.getIsPlaying()),
		);
		const previewMount = canvas.parentElement;
		mount.appendChild(canvas);
		playbackRef.current = playback;
		if (passage)
			playCue({ editor: { playback }, cue: passageWithContext(passage) });
		else playback.play();

		let disposed = false;
		let frame = 0;
		let lastTime = -1;
		const draw = async () => {
			const currentTime = playback.getCurrentTime();
			const lastFrame = lastFrameMediaTime({ duration, fps });
			const time = currentTime < lastFrame ? currentTime : lastFrame;
			if (time !== lastTime && !editor.project.isExportRunning()) {
				lastTime = time;
				const seconds = mediaTimeToSeconds({ time });
				setCaption(
					checkpoint.cues.find(
						({ start, end }) => start <= seconds && seconds < end,
					)?.text ?? "",
				);
				try {
					await renderer.render({ node: tree, time });
				} catch (failure) {
					if (!disposed) {
						playback.pause();
						setError(
							failure instanceof Error ? failure.message : String(failure),
						);
					}
					return;
				}
			}
			if (!disposed) frame = requestAnimationFrame(() => void draw());
		};
		frame = requestAnimationFrame(() => void draw());
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			unsubscribe();
			playback.pause();
			audio.dispose();
			controller.abort();
			videoCache.clearAll();
			if (canvas.parentElement === mount) {
				canvas.remove();
				if (previewMount?.isConnected) previewMount.appendChild(canvas);
			}
			playbackRef.current = null;
		};
	}, [editor, checkpoint, passage, fps, width, height]);

	return (
		<div className="flex flex-col gap-2">
			<div
				ref={canvasMountRef}
				className="flex justify-center bg-black [&>canvas]:max-h-[60vh] [&>canvas]:w-full [&>canvas]:object-contain"
			/>
			{caption && <p className="text-center text-sm">{caption}</p>}
			{error && (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			)}
			<div className="flex gap-2">
				<Button
					variant="outline"
					disabled={checkpoint.durationSeconds === 0 || !!error}
					onClick={() => playbackRef.current?.toggle()}
				>
					{playing ? "Pause" : "Play"}
				</Button>
				<Button
					variant="outline"
					disabled={checkpoint.durationSeconds === 0 || !!error}
					onClick={() => {
						const playback = playbackRef.current;
						if (!playback) return;
						if (passage)
							playCue({
								editor: { playback },
								cue: passageWithContext(passage),
							});
						else {
							playback.seek({ time: ZERO_MEDIA_TIME });
							playback.play();
						}
					}}
				>
					{passage ? "Replay passage" : "Play from start"}
				</Button>
			</div>
		</div>
	);
}
