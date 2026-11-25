"use client";

import { useState } from "react";
import {
	STORAGE_CATEGORIES,
	storageReportSchema,
	type StorageCategory,
	type StorageReport,
} from "@splice/bridge/storage";
import { callSplice } from "@/bridge/splice-api";
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
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatStorageBytes } from "@/services/storage/quota";
import { waveformCache } from "@/services/waveform-cache/service";
import { inspectModelCache } from "@/services/transcription/model-cache";

const CATEGORY_LABELS: Record<StorageCategory, string> = {
	pauses: "Pause scans",
	loudness: "Loudness measurements",
	"noise-reduction": "Noise reduction renders",
	"temporary-renders": "Temporary analysis files",
	"export-staging": "Abandoned export files",
};

function formatBytes(bytes: number) {
	return formatStorageBytes({ bytes });
}

type ModelCache = Awaited<ReturnType<typeof inspectModelCache>>;

function modelSize(model: ModelCache | null): string {
	if (!model) return "Unavailable";
	if (model.kind === "busy") return "In use";
	if (model.kind === "unavailable") return "Unavailable";
	return model.bytes === null
		? `${model.items} files`
		: `About ${formatBytes(model.bytes)}`;
}

export function StorageDialog({ onClose }: { onClose: () => void }) {
	const [report, setReport] = useState<StorageReport | null>(null);
	const [selection, setSelection] =
		useState<readonly StorageCategory[]>(STORAGE_CATEGORIES);
	const [waveforms, setWaveforms] = useState(() => waveformCache.inspect());
	const [clearWaveforms, setClearWaveforms] = useState(true);
	const [model, setModel] = useState<ModelCache | null>(null);
	const [clearModel, setClearModel] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const [errors, setErrors] = useState<string[]>([]);
	const [notice, setNotice] = useState("");

	async function scan({ clean = false } = {}) {
		setBusy(true);
		setErrors([]);
		setNotice("");
		const messages: string[] = [];
		const failures: string[] = [];

		try {
			if (clean && report?.previewToken && selectedDiskCategories.length > 0) {
				try {
					const result = storageReportSchema.parse(
						await callSplice({
							method: "storage.cleanup",
							params: {
								dryRun: false,
								previewToken: report.previewToken,
								categories: selectedDiskCategories,
							},
						}),
					);
					messages.push(`Freed ${formatBytes(result.freedBytes)} on disk.`);
					if (result.newOrChangedItems > 0)
						messages.push(
							"Review the refreshed list to clean up new or changed files.",
						);
					failures.push(
						...result.errors.map(({ path, message }) => `${path} · ${message}`),
					);
				} catch (error) {
					failures.push(
						error instanceof Error ? error.message : "Disk cleanup failed.",
					);
				}
			}
			if (clean && clearWaveforms && waveforms.bytes > 0) {
				const { bytes } = waveformCache.inspect({ remove: true });
				messages.push(`Cleared ${formatBytes(bytes)} from the waveform cache.`);
			}
			const removeModel = clean && clearModel && modelAvailable;
			const [diskResult, modelResult] = await Promise.allSettled([
				callSplice({ method: "storage.report" }).then((data) =>
					storageReportSchema.parse(data),
				),
				inspectModelCache({ remove: removeModel }),
			]);
			if (diskResult.status === "fulfilled") {
				setReport(diskResult.value);
				failures.push(
					...diskResult.value.errors.map(
						({ path, message }) => `${path} · ${message}`,
					),
				);
			} else {
				setReport(null);
				failures.push(
					diskResult.reason instanceof Error
						? diskResult.reason.message
						: "Couldn't read Splice disk storage.",
				);
			}
			if (modelResult.status === "fulfilled") {
				const next = modelResult.value;
				if (next.kind === "ready" && next.removed) {
					messages.push("Removed browser model downloads.");
					setModel({ kind: "ready", items: 0, bytes: 0, removed: false });
				} else {
					setModel(next);
					if (removeModel && next.kind === "busy")
						messages.push(
							"Kept browser model downloads while transcription loads.",
						);
				}
			} else {
				setModel(null);
				failures.push("Couldn't read browser model downloads.");
			}
			setWaveforms(waveformCache.inspect());
			setErrors([...new Set(failures)]);
			setNotice(messages.join(" "));
		} finally {
			setBusy(false);
		}
	}

	const diskBytes =
		report?.categories.reduce(
			(total, row) =>
				total + (selection.includes(row.category) ? row.bytes : 0),
			0,
		) ?? 0;
	const selectedDiskCategories =
		report?.categories
			.filter(
				({ category, items }) => items > 0 && selection.includes(category),
			)
			.map(({ category }) => category) ?? [];
	const modelAvailable = model?.kind === "ready" && model.items > 0;
	const canClean =
		(report?.previewToken && selectedDiskCategories.length > 0) ||
		(clearWaveforms && waveforms.bytes > 0) ||
		(clearModel && modelAvailable);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !busy) onClose();
			}}
		>
			<DialogContent
				className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"
				onOpenAutoFocus={() => void scan()}
			>
				<DialogHeader>
					<DialogTitle>Storage</DialogTitle>
					<DialogDescription>
						Review temporary files and caches before cleaning up.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<fieldset disabled={busy}>
						<legend className="mb-2 text-sm font-medium">Splice disk</legend>
						{report?.categories.map(({ category, bytes, items }) => (
							<label
								key={category}
								className="flex items-center gap-2 border-b py-1.5 text-sm"
							>
								<input
									type="checkbox"
									checked={items > 0 && selection.includes(category)}
									disabled={items === 0}
									onChange={(event) => {
										const checked = event.currentTarget.checked;
										setSelection((current) =>
											checked
												? [...current, category]
												: current.filter((item) => item !== category),
										);
									}}
								/>
								<span>{CATEGORY_LABELS[category]}</span>
								<span className="ml-auto text-muted-foreground tabular-nums">
									{formatBytes(bytes)}
								</span>
							</label>
						))}
						{report && (
							<details className="mt-2 text-sm">
								<summary className="cursor-pointer">Kept on disk</summary>
								<ul className="mt-2 space-y-2 text-muted-foreground">
									{report.kept.map(({ category, reason, bytes }) => (
										<li key={`${category}/${reason}`}>
											<span className="block text-foreground">
												{category} · {formatBytes(bytes)}
											</span>
											{reason}
										</li>
									))}
								</ul>
							</details>
						)}
					</fieldset>
					<fieldset disabled={busy}>
						<legend className="mb-2 text-sm font-medium">This browser</legend>
						<label className="flex items-center gap-2 border-b py-1.5 text-sm">
							<input
								type="checkbox"
								checked={clearWaveforms}
								disabled={waveforms.bytes === 0}
								onChange={(event) =>
									setClearWaveforms(event.currentTarget.checked)
								}
							/>
							<span>Waveforms in this tab</span>
							<span className="ml-auto text-muted-foreground tabular-nums">
								{formatBytes(waveforms.bytes)}
							</span>
						</label>
						{waveforms.busy > 0 && (
							<p className="mt-1 text-xs text-muted-foreground">
								{waveforms.busy} still building
							</p>
						)}
						<label className="flex items-center gap-2 border-b py-1.5 text-sm">
							<input
								type="checkbox"
								checked={clearModel}
								disabled={!modelAvailable}
								onChange={(event) => setClearModel(event.currentTarget.checked)}
							/>
							<span>Transcription model downloads</span>
							<span className="ml-auto text-muted-foreground tabular-nums">
								{modelSize(model)}
							</span>
						</label>
						<p className="mt-2 text-xs text-muted-foreground">
							Splice keeps browser projects, checkpoints, project items, and
							their thumbnails.
						</p>
					</fieldset>
					{errors.length > 0 && (
						<ul className="max-h-32 overflow-auto text-sm text-destructive">
							{errors.map((error) => (
								<li key={error}>{error}</li>
							))}
						</ul>
					)}
					<p aria-live="polite" className="text-sm">
						{busy
							? "Checking storage…"
							: notice || `${formatBytes(diskBytes)} selected on disk`}
					</p>
				</DialogBody>
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={() => void scan()}>
						Refresh
					</Button>
					<Button disabled={busy || !canClean} onClick={() => setConfirm(true)}>
						Clean up
					</Button>
				</DialogFooter>
				<AlertDialog open={confirm} onOpenChange={setConfirm}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Clean up selected caches?</AlertDialogTitle>
							<AlertDialogDescription>
								Splice rebuilds analysis files and waveforms when you need them.
								{clearModel &&
									modelAvailable &&
									" Browser transcription downloads its model again when it next loads."}
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={() => void scan({ clean: true })}>
								Clean up
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</DialogContent>
		</Dialog>
	);
}
