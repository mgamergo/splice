import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { EXPORT_SAMPLE_RATE } from "@/media/audio";
import { TICKS_PER_SECOND } from "@/wasm";
import { frameRateToFloat } from "@/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/export";
import { createCanvasSurface } from "./canvas-utils";
import type { TCanvasSize } from "@/project/types";
import { CanvasRenderer } from "./canvas-renderer";
import { writeOutput } from "./export-output";
import { VideoCache } from "@/services/video-cache/service";

type ExportParams = {
	width: number;
	height: number;
	outputSize?: TCanvasSize;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
	audioBlocks?: AsyncIterable<{ buffer: AudioBuffer; time: number }>;
	/** Cancels the export, along with any video read it is waiting on. */
	signal: AbortSignal;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SequenceExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SequenceExporter extends EventEmitter<SequenceExporterEvents> {
	private renderer: CanvasRenderer;
	private outputSize?: TCanvasSize;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;
	private audioBlocks?: ExportParams["audioBlocks"];
	private signal: AbortSignal;

	constructor({
		width,
		height,
		outputSize,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
		audioBlocks,
		signal,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
			// Its own decoders: the preview, still live during export, would
			// otherwise move them between the clips export is reading.
			videoCache: new VideoCache({ signal }),
		});

		if (
			outputSize &&
			(outputSize.width !== width || outputSize.height !== height)
		)
			this.outputSize = outputSize;
		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
		this.audioBlocks = audioBlocks;
		this.signal = signal;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		try {
			return await this.render({ rootNode });
		} finally {
			this.renderer.videoCache.clearAll();
		}
	}

	private async render({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const outputCanvas = this.renderer.getOutputCanvas();
		const scaled = this.outputSize && createCanvasSurface(this.outputSize);
		// Keep the saved composition's aspect ratio on legacy custom canvases.
		const scale = scaled
			? Math.min(
					scaled.canvas.width / this.renderer.width,
					scaled.canvas.height / this.renderer.height,
				)
			: 1;
		const width = this.renderer.width * scale;
		const height = this.renderer.height * scale;
		const videoSource = new CanvasSource(scaled?.canvas ?? outputCanvas, {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && (this.audioBuffer || this.audioBlocks)) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer?.sampleRate ?? EXPORT_SAMPLE_RATE,
					numberOfChannels: this.audioBuffer?.numberOfChannels ?? 2,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		return writeOutput({
			output,
			write: async () => {
				await output.start();

				if (audioSource && this.audioBuffer) {
					await audioSource.add(this.audioBuffer);
					audioSource.close();
				}
				const blocks = this.audioBlocks?.[Symbol.asyncIterator]();
				let audioUntil = 0;
				try {
					for (let i = 0; i < frameCount; i++) {
						if (this.signal.aborted) {
							await output.cancel();
							this.emit("cancelled");
							return null;
						}

						const timeTicks = i * ticksPerFrame;
						const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
						if (blocks && audioSource && timeSeconds >= audioUntil) {
							const block = await blocks.next();
							if (!block.done) {
								await audioSource.add(block.value.buffer);
								audioUntil = block.value.time + block.value.buffer.duration;
							} else {
								audioSource.close();
								audioUntil = Infinity;
							}
						}
						await this.renderer.render({ node: rootNode, time: timeTicks });
						if (scaled) {
							const { canvas, context } = scaled;
							context.fillRect(0, 0, canvas.width, canvas.height);
							context.drawImage(
								outputCanvas,
								(canvas.width - width) / 2,
								(canvas.height - height) / 2,
								width,
								height,
							);
						}
						await videoSource.add(timeSeconds, 1 / fpsFloat);

						this.emit("progress", i / frameCount);
					}

					if (this.signal.aborted) {
						await output.cancel();
						this.emit("cancelled");
						return null;
					}

					if (blocks && audioSource && audioUntil !== Infinity) {
						for (
							let next = await blocks.next();
							!next.done;
							next = await blocks.next()
						) {
							await audioSource.add(next.value.buffer);
						}
						audioSource.close();
					}
					videoSource.close();
					await output.finalize();
					this.emit("progress", 1);

					const buffer = output.target.buffer;
					if (!buffer) {
						this.emit("error", new Error("Failed to export video"));
						return null;
					}

					this.emit("complete", buffer);
					return buffer;
				} finally {
					await blocks?.return?.();
				}
			},
		});
	}
}
