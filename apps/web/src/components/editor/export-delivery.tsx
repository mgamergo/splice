"use client";

import { Check, Copy, FolderOpen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	Section,
	SectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PopoverContent } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCaptionsStore } from "@/captions/store";
import { useCaptionCues } from "@/captions/use-caption-cues";
import { useEditor } from "@/editor/use-editor";
import {
	DELIVERY_STEP_LABELS,
	EXPORT_QUALITY_VALUES,
	type ExportQuality,
} from "@/export";
import { projectShortStyle } from "@/project/format";
import { DEFAULT_EXPORT_OPTIONS } from "@/export/defaults";
import { ExportGate } from "@/approval/components/export-gate";
import {
	type DeliverySnapshot,
	deliveryFingerprint,
	type ListedExport,
	listExports,
	openExportsFolder,
	takeDeliverySnapshot,
} from "@/export/deliver";

const QUALITY_LABELS: Record<ExportQuality, string> = {
	low: "Low - Smallest file size",
	medium: "Medium - Balanced",
	high: "High - Recommended",
	very_high: "Very high - Largest file size",
};

function isExportQuality(value: string): value is ExportQuality {
	return EXPORT_QUALITY_VALUES.some((quality) => quality === value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Publishes the approved export under Exports and shows earlier exports. */
export function DeliveryPopover() {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActive());
	const sequence = useEditor((e) => e.sequences.getActiveSequence());
	const projectItems = useEditor((e) => e.media.getProjectItems());
	const exportState = useEditor((e) => e.project.getExportState());
	const revision = useEditor((e) => e.command.getRevision());
	// Saved spellings change the SRT without a new revision.
	const spellings = useCaptionsStore((state) => state.spellings);
	const shortStyle = projectShortStyle({ project });
	const cueCount = useCaptionCues().filter(({ text }) => text).length;
	const [includeSrt, setIncludeSrt] = useState(false);
	const { isExporting, progress, result, step } = exportState;
	const [quality, setQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_OPTIONS.quality,
	);
	const [history, setHistory] = useState<{
		folder: string;
		exports: ListedExport[];
	} | null>(null);
	const [historyError, setHistoryError] = useState<string | null>(null);
	const [currentFingerprint, setCurrentFingerprint] = useState<string | null>(
		null,
	);
	const [folderMessage, setFolderMessage] = useState<string | null>(null);
	const projectId = project.metadata.id;

	const refreshHistory = useCallback(async () => {
		try {
			setHistory(await listExports({ projectId }));
			setHistoryError(null);
		} catch (error) {
			setHistoryError(errorMessage(error));
		}
	}, [projectId]);

	useEffect(() => {
		void refreshHistory();
	}, [refreshHistory]);

	// Marks the export, if any, that matches the edit as it is now.
	useEffect(() => {
		let cancelled = false;
		void deliveryFingerprint(takeDeliverySnapshot({ editor })).then(
			(fingerprint) => {
				if (!cancelled) setCurrentFingerprint(fingerprint);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [editor, revision, spellings, sequence, projectItems, project.captions, project.settings]);

	const handleExport = async (snapshot: DeliverySnapshot) => {
		setFolderMessage(null);
		const exported = await editor.project.deliver({
			quality,
			snapshot: shortStyle
				? { ...snapshot, includeSrt: includeSrt && !!snapshot.srt }
				: snapshot,
		});
		if (exported.success) void refreshHistory();
		else if (!exported.failedStep && !exported.cancelled)
			throw new Error(exported.error ?? "Couldn't export the edit.");
	};

	const handleRetry = async () => {
		const exported = await editor.project.retryDelivery();
		if (exported.success) void refreshHistory();
	};

	const handleOpenFolder = async () => {
		try {
			const opened = await openExportsFolder();
			setFolderMessage(
				opened.opened
					? `Opened ${opened.folder}`
					: `${opened.error ?? "Couldn't open it."} The files are in ${opened.folder}.`,
			);
		} catch (error) {
			setFolderMessage(errorMessage(error));
		}
	};

	const failed = result && !result.success && !result.cancelled;
	const record = result?.success ? result.record : undefined;

	return (
		<PopoverContent className="bg-background mr-4 flex max-h-[80vh] w-[min(22rem,calc(100vw-2rem))] flex-col overflow-y-auto p-0">
			<div className="flex items-center justify-between border-b p-3">
				<h3 className="text-sm font-medium">
					{shortStyle
						? isExporting ? "Exporting Short" : "Export Short"
						: isExporting ? "Exporting MP4 and SRT" : "Export MP4 and SRT"}
				</h3>
			</div>

			{failed ? (
				<ExportFailure
					onStartOver={() => editor.project.clearExportState()}
					step={
						result.failedStep
							? DELIVERY_STEP_LABELS[result.failedStep]
							: "Exporting"
					}
					error={result.error ?? "Unknown error"}
					onRetry={handleRetry}
				/>
			) : isExporting ? (
				<div className="flex flex-col gap-3 p-3">
					<div className="flex items-center justify-between text-sm">
						<p aria-live="polite">
							{step ? DELIVERY_STEP_LABELS[step] : "Exporting"}
						</p>
						<p className="text-muted-foreground tabular-nums">
							{Math.round(progress * 100)}%
						</p>
					</div>
					<Progress value={progress * 100} className="w-full" />
					<Button
						variant="outline"
						className="w-full"
						onClick={() => editor.project.cancelExport()}
					>
						Cancel
					</Button>
				</div>
			) : (
				<div className="flex flex-col">
					{record && (
						<div
							role="status"
							className="flex flex-col gap-1 border-b bg-accent/40 p-3 text-sm"
						>
							<p className="flex items-center gap-1.5 font-medium">
								<Check className="text-constructive size-4" /> Exported
							</p>
							<p className="text-muted-foreground text-xs break-all">
								{record.stem}.mp4{record.bytes.srt !== undefined && " and .srt"}, in the folder {record.stem}
							</p>
							{(result?.newerEdit ||
								(currentFingerprint && record.fingerprint !== currentFingerprint)) && (
									<p className="text-muted-foreground text-xs">
										A newer edit is available. This export holds the
										approved revision; export again to deliver the newer
										edit.
									</p>
								)}
						</div>
					)}
					<Section collapsible defaultOpen={false} showTopBorder={false}>
						<SectionHeader>
							<SectionTitle>Quality</SectionTitle>
						</SectionHeader>
						<SectionContent>
							<RadioGroup
								value={quality}
								onValueChange={(value) => {
									if (isExportQuality(value)) setQuality(value);
								}}
							>
								{EXPORT_QUALITY_VALUES.map((value) => (
									<div key={value} className="flex items-center space-x-2">
										<RadioGroupItem value={value} id={`delivery-${value}`} />
										<Label htmlFor={`delivery-${value}`}>
											{QUALITY_LABELS[value]}
										</Label>
									</div>
								))}
							</RadioGroup>
						</SectionContent>
					</Section>
					<div className="flex flex-col gap-2 p-3">
						<p className="text-muted-foreground text-xs">
							{shortStyle
								? "1080×1920 MP4 with burned-in captions, written to Exports."
								: cueCount > 0
								? `1080p30 MP4 without burned-in captions, and an SRT with ${cueCount} cues, written together to Exports.`
								: "No captions yet, so the SRT will be empty. Load transcripts in Captions first."}
						</p>
						{shortStyle && (
							<div className="flex items-center gap-2">
								<Checkbox id="deliver-short-srt" checked={includeSrt} onCheckedChange={(checked) => setIncludeSrt(checked === true)} />
								<Label htmlFor="deliver-short-srt">Include a separate SRT when captions are available</Label>
							</div>
						)}
						<ExportGate onExport={handleExport} />
					</div>
				</div>
			)}

			<ExportHistory
				history={history}
				error={historyError}
				currentFingerprint={currentFingerprint}
				folderMessage={folderMessage}
				onOpenFolder={handleOpenFolder}
			/>
		</PopoverContent>
	);
}

function ExportFailure({
	step,
	error,
	onRetry,
	onStartOver,
}: {
	step: string;
	error: string;
	onRetry: () => void;
	onStartOver: () => void;
}) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex flex-col gap-3 p-3" role="alert">
			<div className="flex flex-col gap-1">
				<p className="text-destructive text-sm font-medium">
					Export failed: {step}
				</p>
				<p className="text-muted-foreground text-xs break-words">{error}</p>
				<p className="text-muted-foreground text-xs">
					Earlier exports are unchanged. Retry exports the same edit and
					never publishes it twice.
				</p>
			</div>
			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={async () => {
						await navigator.clipboard.writeText(`${step}: ${error}`);
						setCopied(true);
						setTimeout(() => setCopied(false), 1000);
					}}
				>
					{copied ? <Check className="text-constructive" /> : <Copy />}
					Copy
				</Button>
				<Button
					variant="outline"
					size="sm"
					className="h-8 flex-1 text-xs"
					onClick={onRetry}
				>
					<RotateCcw />
					Retry
				</Button>
			</div>
			<Button variant="text" size="sm" onClick={onStartOver}>Back to export options</Button>
		</div>
	);
}

function ExportHistory({
	history,
	error,
	currentFingerprint,
	folderMessage,
	onOpenFolder,
}: {
	history: { folder: string; exports: ListedExport[] } | null;
	error: string | null;
	currentFingerprint: string | null;
	folderMessage: string | null;
	onOpenFolder: () => void;
}) {
	return (
		<section className="flex flex-col gap-2 border-t p-3" aria-label="Exports">
			<div className="flex items-center justify-between gap-2">
				<h4 className="text-xs font-medium">Earlier exports</h4>
				<Button variant="outline" size="sm" onClick={onOpenFolder}>
					<FolderOpen />
					Open folder
				</Button>
			</div>
			{folderMessage && (
				<p className="text-muted-foreground text-xs break-all" role="status">
					{folderMessage}
				</p>
			)}
			{error ? (
				<p className="text-destructive text-xs" role="alert">
					{error}
				</p>
			) : !history ? (
				<p className="text-muted-foreground text-xs">Loading…</p>
			) : history.exports.length === 0 ? (
				<p className="text-muted-foreground text-xs">
					None yet. Exports go to {history.folder}.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{history.exports.map((entry) => (
						<li
							key={entry.stem}
							className="flex flex-col gap-0.5 rounded-md border p-2 text-xs"
						>
							<span className="flex flex-wrap items-center gap-1.5">
								<time dateTime={entry.exportedAt} className="font-medium">
									{new Date(entry.exportedAt).toLocaleString()}
								</time>
								{!entry.checkpointId && entry.fingerprint === currentFingerprint && (
									<Badge variant="secondary" className="px-1.5 py-0 text-[0.65rem]">
										Current edit
									</Badge>
								)}
								{!entry.present && (
									<Badge
										variant="destructive"
										className="px-1.5 py-0 text-[0.65rem]"
									>
										Files moved
									</Badge>
								)}
							</span>
							<span className="text-muted-foreground">
								{entry.projectName} · {entry.sequenceName} · revision{" "}
								{entry.revision}
							</span>
							<span className="text-muted-foreground break-all">
								{entry.files.mp4}{entry.files.srt && `, ${entry.files.srt}`}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
