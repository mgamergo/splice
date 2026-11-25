import { describe, expect, mock, test } from "bun:test";

// Bun hoists static imports, so the exporter is replaced before anything loads it.
const real = await import("@/services/renderer/sequence-exporter");
type Params = ConstructorParameters<typeof real.SequenceExporter>[0];

/** What each render was given, and how the fake exporter answers it. */
const renders: Params[] = [];
let failWith: (params: Params) => Error | null = () => null;

class FakeExporter {
	constructor(private params: Params) {
		renders.push(params);
	}
	on() {}
	async export() {
		const error = failWith(this.params);
		if (error) throw error;
		return { streamed: true as const, encoder: "default" as const };
	}
}
mock.module("@/services/renderer/sequence-exporter", () => ({
	...real,
	SequenceExporter: FakeExporter,
}));

const { setUpEditor, videoClip } = await import("@/agent/__tests__/fixtures");
const { buildDefaultSequence } = await import("@/timeline/sequences");

const encodingError = () => new DOMException("Encoding error.", "EncodingError");

function exportWithStreams() {
	const { main } = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	const editor = setUpEditor({
		tracks: {
			main: { ...main, clips: [videoClip({ id: "a", start: 0, duration: 2 })] },
		},
	});
	const streams: WritableStream[] = [];
	renders.length = 0;
	const result = editor.renderer.exportProject({
		options: { format: "mp4", quality: "high" },
		signal: new AbortController().signal,
		createStream: () => {
			const stream = new WritableStream();
			streams.push(stream);
			return stream;
		},
	});
	return { result, streams };
}

describe("export encoder fallback", () => {
	test("renders again on the default encoder, into a fresh file, when the GPU encoder fails", async () => {
		failWith = ({ hardwareEncoder }) =>
			hardwareEncoder
				? new real.ExportEncoderError({
						track: "video",
						encoder: "hardware",
						cause: encodingError(),
					})
				: null;
		const { result, streams } = exportWithStreams();
		expect(await result).toMatchObject({ success: true, streamed: true });
		expect(renders.map(({ hardwareEncoder }) => hardwareEncoder)).toEqual([true, false]);
		expect(streams).toHaveLength(2);
		expect(renders[1].stream).toBe(streams[1]);
	});

	test("reports which encoder failed when it wasn't the GPU's", async () => {
		failWith = () =>
			new real.ExportEncoderError({
				track: "audio",
				encoder: "default",
				cause: encodingError(),
			});
		const { result } = exportWithStreams();
		expect(await result).toMatchObject({
			success: false,
			error: "The audio encoder failed: Encoding error.",
		});
		expect(renders).toHaveLength(1);
	});
});
