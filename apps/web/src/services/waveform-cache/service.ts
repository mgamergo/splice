"use client";

import { createAudioContext } from "@/media/audio";
import {
	buildSourceWaveformSummary,
	buildStreamedWaveformSummary,
	type SourceWaveformSummary,
} from "@/media/waveform-summary";
import { createMediaSource, isDiskMedia } from "@/media/media-data";
import type { MediaData } from "@/media/types";
import { ALL_FORMATS, AudioBufferSink, Input } from "mediabunny";

interface GetSourceWaveformSummaryArgs {
	sourceKey: string;
	audioBuffer?: AudioBuffer;
	sourceFile?: MediaData;
	audioUrl?: string;
}

export class WaveformCache {
	private summaries = new Map<
		string,
		{
			promise: Promise<SourceWaveformSummary>;
			bytes: number | null;
		}
	>();

	getSourceSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		const existing = this.summaries.get(sourceKey);
		if (existing) {
			return existing.promise;
		}

		const entry: {
			bytes: number | null;
			promise: Promise<SourceWaveformSummary>;
		} = {
			bytes: null,
			promise: this.buildSummary({
				sourceKey,
				audioBuffer,
				sourceFile,
				audioUrl,
			}),
		};
		entry.promise = entry.promise.then(
			(summary) => {
				entry.bytes = summary.amplitudes.byteLength;
				return summary;
			},
			(error: unknown) => {
				if (this.summaries.get(sourceKey) === entry)
					this.summaries.delete(sourceKey);
				throw error;
			},
		);
		this.summaries.set(sourceKey, entry);
		return entry.promise;
	}

	/** A component already showing a waveform retains its own summary. */
	inspect({ remove = false } = {}) {
		let bytes = 0;
		let busy = 0;
		for (const [key, entry] of this.summaries) {
			if (entry.bytes === null) {
				busy++;
			} else {
				bytes += entry.bytes;
				if (remove) this.summaries.delete(key);
			}
		}
		return { bytes, busy };
	}

	clearSource({ sourceKey }: { sourceKey: string }): void {
		this.summaries.delete(sourceKey);
	}

	clearAll(): void {
		this.summaries.clear();
	}

	private async buildSummary({
		sourceKey,
		audioBuffer,
		sourceFile,
		audioUrl,
	}: GetSourceWaveformSummaryArgs): Promise<SourceWaveformSummary> {
		if (audioBuffer) {
			return buildSourceWaveformSummary({ sourceKey, buffer: audioBuffer });
		}

		if (sourceFile && isDiskMedia(sourceFile)) {
			return buildDiskWaveformSummary({ sourceKey, source: sourceFile });
		}

		let arrayBuffer: ArrayBuffer | null = null;
		if (sourceFile) {
			arrayBuffer = await sourceFile.arrayBuffer();
		} else if (audioUrl) {
			const response = await fetch(audioUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch waveform source: ${response.status}`);
			}
			arrayBuffer = await response.arrayBuffer();
		}

		if (!arrayBuffer) {
			throw new Error(`No waveform source available for ${sourceKey}`);
		}

		const audioContext = createAudioContext();
		try {
			const buffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
			return buildSourceWaveformSummary({ sourceKey, buffer });
		} finally {
			void audioContext.close();
		}
	}
}

async function buildDiskWaveformSummary({
	sourceKey,
	source,
}: {
	sourceKey: string;
	source: MediaData;
}): Promise<SourceWaveformSummary> {
	const input = new Input({
		source: createMediaSource({ data: source }),
		formats: ALL_FORMATS,
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) {
			throw new Error(`No audio track in ${sourceKey}`);
		}
		const sink = new AudioBufferSink(track);
		return await buildStreamedWaveformSummary({
			sourceKey,
			chunks: sink.buffers(),
		});
	} finally {
		input.dispose();
	}
}

export const waveformCache = new WaveformCache();
