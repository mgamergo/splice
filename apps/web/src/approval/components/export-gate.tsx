"use client";

import { Download } from "lucide-react";
import { useId, useState } from "react";
import { sequenceCaptionCues } from "@/captions/project-captions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import type { DeliverySnapshot } from "@/export/deliver";
import { projectFormat } from "@/project/format";
import { measureMixLoudness, saveMixLoudness } from "@/mix/final-mix";
import {
	captureApproval,
	checkpointDeliverySnapshot,
	commitApproval,
} from "../checkpoint";
import { useApprovalSpellings, useReviewState } from "../hooks";
import { watchApprovedCut } from "../playback";
import {
	approvedIssues,
	hasUnavailableExportMedia,
	reviewState,
} from "../review";
import { IssueRow } from "./issue-row";
import { formatApproved } from "./review-panel";

type Version = "current" | "approved";

export function ExportGate({
	onExport,
}: {
	onExport: (snapshot: DeliverySnapshot) => Promise<void>;
}) {
	const editor = useEditor();
	const review = useReviewState();
	const horizontal = useEditor((e) => projectFormat({ project: e.project.getActive() }) === "horizontal");
	const spellings = useApprovalSpellings({ enabled: horizontal });
	const loadingSpellings = horizontal && !spellings.ready;
	const dragging = useEditor((e) => e.timeline.isPreviewActive());
	const [version, setVersion] = useState<Version>("current");
	const [starting, setStarting] = useState(false);
	const [measuring, setMeasuring] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = useId();

	if (!review) return null;
	const { checkpoint, sequence } = review;
	const approved = version === "approved" ? checkpoint : undefined;
	const issues = approved
		? approvedIssues({ editor, checkpoint: approved })
		: review.issues;
	const stale = issues.find(({ kind }) => kind === "stale-mix");
	const blocking = issues.filter(
		({ dismissed, kind }) => !dismissed && kind !== "stale-mix",
	);
	const assertReviewedMix = (latestIssues: typeof issues) => {
		const latest = latestIssues.find(({ kind }) => kind === "stale-mix");
		if (latest?.evidence !== stale?.evidence)
			throw new Error("The mix changed. Review it before exporting.");
	};
	const unavailable = hasUnavailableExportMedia({
		issues,
		approved: !!approved,
	});

	const handleExport = async () => {
		setError(null);
		setStarting(true);
		try {
			if (
				editor.timeline.isPreviewActive() ||
				sequence !== editor.sequences.getActiveSequence()
			)
				throw new Error("The edit changed. Review it before exporting.");
			if (approved) {
				const issues = approvedIssues({
					editor,
					checkpoint: approved,
				});
				assertReviewedMix(issues);
				if (
					issues.some(
						({ dismissed, kind }) => !dismissed && kind !== "stale-mix",
					) ||
					hasUnavailableExportMedia({ issues, approved: true })
				)
					throw new Error(
						"Resolve the issues on the approved cut before exporting.",
					);
				await onExport(
					checkpointDeliverySnapshot({ editor, checkpoint: approved }),
				);
				return;
			}
			const cues = horizontal ? sequenceCaptionCues({ editor, sequence }) : undefined;
			const current = reviewState({ editor, sequence, cues });
			if (
				hasUnavailableExportMedia({ issues: current.issues, approved: false })
			)
				throw new Error("Restore the missing recordings before exporting.");
			assertReviewedMix(current.issues);
			if (current.unresolved.some(({ kind }) => kind !== "stale-mix"))
				throw new Error("Review the unresolved issues before exporting.");
			const capture = captureApproval({ editor, origin: "export", cues });
			const { snapshot } = await commitApproval({ editor, capture });
			await onExport(snapshot);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setStarting(false);
		}
	};

	const handleRemeasure = async () => {
		const loudness = sequence.mix?.loudness;
		if (!loudness) return;
		const revision = editor.command.getRevision();
		setMeasuring(true);
		setError(null);
		try {
			const measured = await measureMixLoudness({
				editor,
				sequenceId: sequence.id,
				targetLufs: loudness.targetLufs,
				ceilingDbtp: loudness.ceilingDbtp,
			});
			if (editor.command.getRevision() !== revision)
				throw new Error("The edit changed while measuring. Measure it again.");
			saveMixLoudness({ editor, sequenceId: sequence.id, loudness: measured });
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setMeasuring(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{checkpoint && (
				<RadioGroup
					value={approved ? "approved" : "current"}
					onValueChange={(value) => {
						if (value === "current" || value === "approved") setVersion(value);
					}}
					aria-label="Which edit to export"
					className="gap-1.5"
					disabled={starting || measuring}
				>
					<div className="flex items-center gap-2">
						<RadioGroupItem value="current" id={id + "-current"} />
						<Label htmlFor={id + "-current"} className="text-xs font-normal">
							Current edit
						</Label>
					</div>
					<div className="flex items-center gap-2">
						<RadioGroupItem value="approved" id={id + "-approved"} />
						<Label htmlFor={id + "-approved"} className="text-xs font-normal">
							Approved cut from {formatApproved(checkpoint)}
						</Label>
					</div>
				</RadioGroup>
			)}
			{blocking.length > 0 && (
				<section
					aria-label="Issues before export"
					className="flex flex-col gap-1.5"
				>
					<p className="text-xs font-medium" role="status">
						Fix or dismiss {blocking.length}{" "}
						{blocking.length === 1 ? "issue" : "issues"} to export.
					</p>
					<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
						{blocking.map((issue) => (
							<IssueRow
								key={issue.id}
								issue={issue}
								onPlay={
									approved
										? () =>
												watchApprovedCut({
													editor,
													checkpoint: approved,
													passage: issue,
												})
										: undefined
								}
							/>
						))}
					</ul>
				</section>
			)}
			{stale && (
				<div className="flex flex-col gap-1.5">
					<p className="text-muted-foreground text-xs" role="status">
						{stale.detail}
					</p>
					{!approved && (
						<Button
							variant="outline"
							disabled={starting || measuring || dragging}
							onClick={handleRemeasure}
						>
							{measuring ? "Measuring…" : "Remeasure mix"}
						</Button>
					)}
				</div>
			)}
			{unavailable && (
				<p className="text-destructive text-xs" role="status">
					{approved
						? "Restore the approved cut’s recordings to export it."
						: "Restore the missing recordings before exporting."}
				</p>
			)}
			{spellings.error && !approved && (
				<div className="flex items-center justify-between gap-2 text-xs">
					<p role="alert">{spellings.error}</p>
					<Button size="sm" variant="outline" onClick={spellings.retry}>
						Retry loading spellings
					</Button>
				</div>
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
			<Button
				onClick={handleExport}
				className="w-full gap-2"
				disabled={
					starting ||
					measuring ||
					dragging ||
					unavailable ||
					(!approved && loadingSpellings) ||
					blocking.length > 0
				}
			>
				{starting || (!approved && loadingSpellings && !spellings.error) ? (
					<Spinner />
				) : (
					<Download className="size-4" />
				)}
				{approved
					? stale
						? "Export approved cut with saved gain"
						: "Export approved cut"
					: stale
						? "Approve and export with saved gain"
						: "Approve and export"}
			</Button>
		</div>
	);
}
