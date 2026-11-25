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
import {
	captureApproval,
	checkpointDeliverySnapshot,
	commitApproval,
} from "../checkpoint";
import { useApprovalSpellings, useReviewState } from "../hooks";
import { watchApprovedCut } from "../playback";
import { approvedIssues, reviewState } from "../review";
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
	const spellings = useApprovalSpellings();
	const dragging = useEditor((e) => e.timeline.isPreviewActive());
	const [version, setVersion] = useState<Version>("current");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const id = useId();

	if (!review) return null;
	const { checkpoint, sequence } = review;
	const approved = version === "approved" ? checkpoint : undefined;
	const issues = approved
		? approvedIssues({ editor, checkpoint: approved, sequence })
		: review.issues;
	const blocking = issues.filter(({ dismissed }) => !dismissed);
	const unavailable =
		!!approved &&
		issues.some(
			({ kind }) => kind === "changed-footage" || kind === "missing-footage",
		);

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
					sequence,
				});
				if (
					issues.some(
						({ dismissed, kind }) =>
							!dismissed ||
							kind === "changed-footage" ||
							kind === "missing-footage",
					)
				)
					throw new Error(
						"Resolve the issues on the approved cut before exporting.",
					);
				await onExport(
					checkpointDeliverySnapshot({ editor, checkpoint: approved }),
				);
				return;
			}
			const cues = sequenceCaptionCues({ editor, sequence });
			if (reviewState({ editor, sequence, cues }).unresolved.length)
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
					disabled={starting}
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
			{unavailable && (
				<p className="text-destructive text-xs" role="status">
					Restore the approved cut’s recordings to export it.
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
					dragging ||
					unavailable ||
					(!approved && !spellings.ready) ||
					blocking.length > 0
				}
			>
				{starting || (!approved && !spellings.ready && !spellings.error) ? (
					<Spinner />
				) : (
					<Download className="size-4" />
				)}
				{approved ? "Export approved cut" : "Approve and export"}
			</Button>
		</div>
	);
}
