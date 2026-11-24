import type { ExportRecord } from "@splice/bridge/delivery";
import type { FrameRate } from "opencut-wasm";
import { EXPORT_MIME_TYPES } from "./mime-types";

export const EXPORT_QUALITY_VALUES = [
	"low",
	"medium",
	"high",
	"very_high",
] as const;

export const EXPORT_FORMAT_VALUES = ["mp4", "webm"] as const;

export type ExportFormat = (typeof EXPORT_FORMAT_VALUES)[number];
export type ExportQuality = (typeof EXPORT_QUALITY_VALUES)[number];

export interface ExportOptions {
	format: ExportFormat;
	quality: ExportQuality;
	fps?: FrameRate;
	includeAudio?: boolean;
}

/** The steps of a Horizontal export, which publishes an MP4/SRT pair under Exports. */
export const DELIVERY_STEPS = [
	"render",
	"upload-video",
	"upload-captions",
	"publish",
] as const;
export type DeliveryStep = (typeof DELIVERY_STEPS)[number];

export const DELIVERY_STEP_LABELS: Record<DeliveryStep, string> = {
	render: "Rendering the video",
	"upload-video": "Writing the MP4 to Exports",
	"upload-captions": "Writing the SRT to Exports",
	publish: "Publishing the MP4 and SRT",
};

export interface ExportResult {
	success: boolean;
	buffer?: ArrayBuffer;
	error?: string;
	cancelled?: boolean;
	/** The step a Horizontal export failed at. */
	failedStep?: DeliveryStep;
	/** The pair a Horizontal export published. */
	record?: ExportRecord;
}

export interface ExportState {
	isExporting: boolean;
	progress: number;
	result: ExportResult | null;
	/** The step a Horizontal export is on. */
	step?: DeliveryStep;
}

export function getExportMimeType({
	format,
}: {
	format: ExportFormat;
}): string {
	return EXPORT_MIME_TYPES[format];
}

export function getExportFileExtension({
	format,
}: {
	format: ExportFormat;
}): string {
	return `.${format}`;
}

export function downloadBuffer({
	buffer,
	filename,
	mimeType,
}: {
	buffer: ArrayBuffer;
	filename: string;
	mimeType: string;
}): void {
	const blob = new Blob([buffer], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const downloadLink = document.createElement("a");
	downloadLink.href = url;
	downloadLink.download = filename;
	document.body.appendChild(downloadLink);
	downloadLink.click();
	document.body.removeChild(downloadLink);
	URL.revokeObjectURL(url);
}
