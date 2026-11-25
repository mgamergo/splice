import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	type StreamTargetChunk,
	CanvasSource,
	AudioBufferSource,
	canEncodeVideo,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
	type VideoCodec,
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
	audioBlocks?: AsyncIterable<{ buffer: AudioBuffer; time: number }>;
	/**
	 * Where the file goes as it renders. Without one, the export resolves
	 * with the whole file in memory.
	 */
	stream?: WritableStream<StreamTargetChunk>;
	/** Cancels the export, along with any video read it is waiting on. */
	signal: AbortSignal;
};

/** What an export produced: the file, or confirmation it went to the stream. */
export type ExportedVideo =
	| { buffer: ArrayBuffer; encoder: EncoderChoice }
	| { streamed: true; encoder: EncoderChoice };

/** Whether the video encoder was asked to use the GPU's media engine. */
export type EncoderChoice = "hardware" | "default";

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

/** Writes to `splice` in pieces large enough that request overhead doesn't matter. */
const STREAM_CHUNK_BYTES = 8 * 1024 * 1024;

/** How often progress is reported; every frame would re-render the dialog 30 times a second. */
const PROGRESS_INTERVAL_MS = 200;

export type SequenceExporterEvents = {
	progress: [progress: number];
	complete: [];
	error: [error: Error];
	cancelled: [];
};

/**
 * Prefers the GPU's encoder (NVENC, AMF, Quick Sync), which is several
 * times faster than software encoding and leaves the CPU to decode and
 * composite. Falls back to the browser's choice where none can take the
 * size and bitrate.
 */
async function chooseEncoder({
	codec,
	width,
	height,
	bitrate,
}: {
	codec: VideoCodec;
	width: number;
	height: number;
	bitrate: (typeof qualityMap)[ExportQuality];
}): Promise<EncoderChoice> {
	try {
		return (await canEncodeVideo(codec, {
			width,
			height,
			bitrate,
			hardwareAcceleration: "prefer-hardware",
		}))
			? "hardware"
			: "default";
	} catch {
		return "default";
	}
}

export class SequenceExporter extends EventEmitter<SequenceExporterEvents> {
	private renderer: CanvasRenderer;
	private outputSize?: TCanvasSize;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBlocks?: ExportParams["audioBlocks"];
	private stream?: WritableStream<StreamTargetChunk>;
	private signal: AbortSignal;

	constructor({
		width,
		height,
		outputSize,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBlocks,
		stream,
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
		this.audioBlocks = audioBlocks;
		this.stream = stream;
		this.signal = signal;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ExportedVideo | null> {
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
	}): Promise<ExportedVideo | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);
		const durationSeconds = frameCount / fpsFloat;
		const audioCodec = this.shouldIncludeAudio && this.audioBlocks
			? await this.chooseAudioCodec()
			: null;

		// Reserving room for the index at the front gives a file that starts
		// playing before it has downloaded, written in one pass and never held
		// whole: the muxer fills the index in once the last frame is written.
		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: "reserve" });
		const output = new Output({
			format: outputFormat,
			target: this.stream
				? new StreamTarget(this.stream, {
						chunked: true,
						chunkSize: STREAM_CHUNK_BYTES,
					})
				: new BufferTarget(),
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
		const codec: VideoCodec = this.format === "webm" ? "vp9" : "avc";
		const bitrate = qualityMap[this.quality];
		const encoder = await chooseEncoder({
			codec,
			width: scaled?.canvas.width ?? this.renderer.width,
			height: scaled?.canvas.height ?? this.renderer.height,
			bitrate,
		});
		const videoSource = new CanvasSource(scaled?.canvas ?? outputCanvas, {
			codec,
			bitrate,
			...(encoder === "hardware" && { hardwareAcceleration: "prefer-hardware" }),
		});

		output.addVideoTrack(videoSource, {
			frameRate: fpsFloat,
			maximumPacketCount: frameCount + 1,
		});

		let audioSource: AudioBufferSource | null = null;
		if (audioCodec) {
			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			// AAC frames hold 1024 samples and Opus 20 ms; the margin covers
			// encoder priming and the last partial frame.
			const packetSeconds =
				audioCodec === "aac" ? 1024 / EXPORT_SAMPLE_RATE : 0.02;
			output.addAudioTrack(audioSource, {
				maximumPacketCount: Math.ceil(durationSeconds / packetSeconds) + 64,
			});
		}

		return writeOutput({
			output,
			write: async () => {
				await output.start();

				const blocks = audioSource
					? this.audioBlocks?.[Symbol.asyncIterator]()
					: undefined;
				// The next second of audio decodes while frames render.
				let nextBlock = blocks?.next();
				let audioUntil = blocks ? 0 : Infinity;
				const addAudioUntil = async (seconds: number) => {
					while (nextBlock && audioSource && seconds >= audioUntil) {
						const block = await nextBlock;
						if (block.done) {
							nextBlock = undefined;
							audioSource.close();
							audioUntil = Infinity;
							return;
						}
						nextBlock = blocks!.next();
						await audioSource.add(block.value.buffer);
						audioUntil = block.value.time + block.value.buffer.duration;
					}
				};
				const cancel = async () => {
					await output.cancel();
					this.emit("cancelled");
					return null;
				};

				let encoding: Promise<void> | null = null;
				let reportedAt = 0;
				try {
					for (let i = 0; i < frameCount; i++) {
						if (this.signal.aborted) return await cancel();

						const timeTicks = i * ticksPerFrame;
						const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
						await addAudioUntil(timeSeconds);
						// Renders this frame while the encoder takes the last one.
						await this.renderer.render({ node: rootNode, time: timeTicks });
						await encoding;
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
						// The canvas is captured before `add` returns, so the next
						// frame can draw over it straight away.
						encoding = videoSource.add(timeSeconds, 1 / fpsFloat);

						const now = performance.now();
						if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
							reportedAt = now;
							this.emit("progress", i / frameCount);
						}
					}
					await encoding;

					if (this.signal.aborted) return await cancel();

					await addAudioUntil(Infinity);
					videoSource.close();
					await output.finalize();
					this.emit("progress", 1);
					this.emit("complete");

					if (this.stream) return { streamed: true, encoder };
					const buffer =
						output.target instanceof BufferTarget ? output.target.buffer : null;
					if (!buffer) {
						this.emit("error", new Error("Failed to export video"));
						return null;
					}
					return { buffer, encoder };
				} finally {
					// A failed frame leaves its encode unobserved; the output is cancelled anyway.
					encoding?.catch(() => {});
					await blocks?.return?.();
				}
			},
		});
	}

	private async chooseAudioCodec(): Promise<"aac" | "opus"> {
		if (this.format === "webm" || typeof AudioEncoder === "undefined")
			return this.format === "webm" ? "opus" : "aac";
		const { supported } = await AudioEncoder.isConfigSupported({
			codec: "mp4a.40.2",
			sampleRate: EXPORT_SAMPLE_RATE,
			numberOfChannels: 2,
			bitrate: 192000,
		});
		return supported ? "aac" : "opus";
	}
}
