"use client";

import type { ChangedPassage } from "@splice/bridge/approval";
import { Check, FolderOpen, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PanelView } from "@/components/editor/panels/library/views/base-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import { openExportsFolder } from "@/export/deliver";
import { finalizeCut } from "../checkpoint";
import { describeChanges } from "../compare";
import { useProjectExports, useReviewState } from "../hooks";
import { playPassage, restoreCheckpoint, watchApprovedCut } from "../playback";
import type { ApprovedCheckpoint } from "../types";
import { formatTime, IssueRow } from "./issue-row";

const ORIGIN_LABELS: Record<ApprovedCheckpoint["origin"], string> = {
	editor: "in Splice",
	agent: "through the agent",
	export: "by exporting",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatApproved(checkpoint: ApprovedCheckpoint): string {
	return new Date(checkpoint.approvedAt).toLocaleString();
}

/**
 * Approval for the active sequence: finalize the cut, see and play what
 * changed since, return to it, and work through review issues.
 */
export function ReviewPanel() {
	const editor = useEditor();
	const review = useReviewState();
	const [showDismissed, setShowDismissed] = useState(false);
	const [finalizing, setFinalizing] = useState(false);

	if (!review) return null;
	const { checkpoint, comparison, issues, unresolved } = review;
	const dismissed = issues.filter((issue) => issue.dismissed);

	const handleFinalize = async () => {
		setFinalizing(true);
		try {
			const { saved } = await finalizeCut({ editor, origin: "editor" });
			toast.success(
				saved
					? "Cut finalized. This exact edit is kept as the approved cut."
					: "This edit is already the approved cut.",
			);
		} catch (error) {
			toast.error(`Couldn't finalize the cut: ${errorMessage(error)}`);
		} finally {
			setFinalizing(false);
		}
	};

	return (
		<PanelView title="Review" contentClassName="flex flex-col gap-3 pb-4">
			<section aria-label="Approved cut" className="flex flex-col gap-2 px-1">
				{checkpoint ? (
					<>
						<p className="text-sm">
							Approved {formatApproved(checkpoint)}{" "}
							<span className="text-muted-foreground">
								{ORIGIN_LABELS[checkpoint.origin]}
							</span>
						</p>
						{checkpoint.note && (
							<p className="text-muted-foreground text-xs break-words">
								“{checkpoint.note}”
							</p>
						)}
						<p className="text-muted-foreground text-xs" aria-live="polite">
							{comparison?.identical
								? "No sequence changes since approval."
								: `Since approval · ${describeChanges(comparison?.changes ?? [])}`}
						</p>
					</>
				) : (
					<p className="text-muted-foreground text-xs">
						Finalize the cut after watching it to keep this version for
						comparison, restore, and export.
					</p>
				)}
				<div className="flex flex-wrap gap-1.5">
					<Button
						size="sm"
						className="h-7"
						onClick={handleFinalize}
						disabled={finalizing}
					>
						{finalizing ? <Spinner /> : <Check />}
						{checkpoint ? "Approve current edit" : "Finalize cut"}
					</Button>
					{checkpoint && (
						<>
							<Button
								size="sm"
								variant="outline"
								className="h-7"
								onClick={() => watchApprovedCut({ editor, checkpoint })}
							>
								<Play />
								Watch approved cut
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="h-7"
								onClick={() => {
									if (restoreCheckpoint({ editor, checkpoint }))
										toast.success(
											"Returned to the approved cut. Undo to get the newer edit back.",
										);
								}}
							>
								<RotateCcw />
								Return to approved cut
							</Button>
						</>
					)}
				</div>
			</section>

			{checkpoint && comparison && !comparison.identical && (
				<section
					aria-label="Changes since approval"
					className="flex flex-col gap-1.5 border-t px-1 pt-3"
				>
					<h3 className="text-muted-foreground text-xs font-medium">
						Changed since approval
					</h3>
					<ul className="flex flex-col gap-1">
						{comparison.passages.map((passage) => (
							<PassageRow
								key={`${passage.start}-${passage.approvedStart}`}
								passage={passage}
								checkpoint={checkpoint}
							/>
						))}
					</ul>
				</section>
			)}

			<section
				aria-label="Review issues"
				className="flex flex-col gap-1.5 border-t px-1 pt-3"
			>
				<h3 className="text-muted-foreground text-xs font-medium">
					{unresolved.length
						? `${unresolved.length} ${unresolved.length === 1 ? "issue" : "issues"} to fix or dismiss`
						: "No issues to review"}
				</h3>
				<ul className="flex flex-col gap-1">
					{unresolved.map((issue) => (
						<IssueRow key={issue.id} issue={issue} />
					))}
				</ul>
				{dismissed.length > 0 && (
					<Button
						variant="text"
						size="sm"
						className="h-auto self-start p-0 text-xs"
						onClick={() => setShowDismissed((shown) => !shown)}
						aria-expanded={showDismissed}
					>
						{showDismissed ? "Hide" : "Show"} {dismissed.length} dismissed
					</Button>
				)}
				{showDismissed && (
					<ul className="flex flex-col gap-1">
						{dismissed.map((issue) => (
							<IssueRow key={issue.id} issue={issue} />
						))}
					</ul>
				)}
			</section>

			<LatestExport />
		</PanelView>
	);
}

function PassageRow({
	passage,
	checkpoint,
}: {
	passage: ChangedPassage;
	checkpoint: ApprovedCheckpoint;
}) {
	const editor = useEditor();
	const labels = [...new Set(passage.changes.map(({ label }) => label))];
	return (
		<li className="flex flex-col gap-1 rounded-md border p-1.5 text-xs">
			<span className="flex flex-wrap items-center gap-1.5">
				<span className="font-medium tabular-nums">
					{formatTime(passage.start)}
					{passage.end > passage.start && ` – ${formatTime(passage.end)}`}
				</span>
				<span className="text-muted-foreground">
					{describeChanges(passage.changes)}
				</span>
			</span>
			<span className="text-muted-foreground break-words">
				{labels.slice(0, 4).join(" · ")}
			</span>
			<span className="flex gap-1.5">
				<Button
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
					onClick={() =>
						playPassage({ editor, start: passage.start, end: passage.end })
					}
				>
					<Play />
					Play now
				</Button>
				<Button
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
					onClick={() =>
						watchApprovedCut({
							editor,
							checkpoint,
							passage: {
								start: passage.approvedStart,
								end: passage.approvedEnd,
							},
						})
					}
				>
					<Play />
					Play approved
				</Button>
			</span>
		</li>
	);
}

/** Which edit the latest export holds, with the folder it's in. */
export function LatestExport() {
	const { exports, error } = useProjectExports();
	const [message, setMessage] = useState<string | null>(null);
	const latest = exports?.[0];
	if (error || !latest) return null;
	return (
		<section
			aria-label="Latest export"
			className="flex flex-col gap-1.5 border-t px-1 pt-3 text-xs"
		>
			<h3 className="text-muted-foreground font-medium">Latest export</h3>
			<p>
				{new Date(latest.exportedAt).toLocaleString()} · {latest.sequenceName} ·
				Revision {latest.revision}
			</p>
			<p className="text-muted-foreground break-all">
				{latest.files.mp4}, {latest.files.srt}
				{!latest.present && " (moved or deleted)"}
			</p>
			<Button
				size="sm"
				variant="outline"
				className="h-7 self-start"
				onClick={async () => {
					try {
						const opened = await openExportsFolder();
						setMessage(
							opened.opened
								? `Opened ${opened.folder}`
								: `${opened.error ?? "Couldn't open it."} The files are in ${opened.folder}.`,
						);
					} catch (failure) {
						setMessage(errorMessage(failure));
					}
				}}
			>
				<FolderOpen />
				Open folder
			</Button>
			{message && (
				<p className="text-muted-foreground break-all" role="status">
					{message}
				</p>
			)}
		</section>
	);
}
