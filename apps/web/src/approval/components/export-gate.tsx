"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { useEditor } from "@/editor/use-editor";
import type { DeliverySnapshot } from "@/export/deliver";
import { checkpointDeliverySnapshot, finalizeCut } from "../checkpoint";
import { useReviewState } from "../hooks";
import { IssueRow } from "./issue-row";
import { formatApproved } from "./review-panel";

type Version = "current" | "approved";

/**
 * Export is the creator's final approval. The current edit exports only once
 * every review issue is fixed or dismissed, and exporting it saves it as the
 * approved checkpoint; the MP4 and SRT both come from that one checkpoint.
 * An earlier approved cut exports as it was approved.
 */
export function ExportGate({
	onExport,
	disabled,
}: {
	onExport: (snapshot: DeliverySnapshot) => Promise<void>;
	disabled?: boolean;
}) {
	const editor = useEditor();
	const review = useReviewState();
	const [version, setVersion] = useState<Version>("current");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (!review) return null;
	const { checkpoint, comparison, unresolved } = review;
	const differs = !!checkpoint && !!comparison && !comparison.identical;
	const chosen: Version = differs ? version : "current";
	// The approved cut was reviewed already; only recordings it can't play block it.
	const blocking =
		chosen === "current"
			? unresolved
			: unresolved.filter(({ kind }) => kind === "missing-footage");

	const handleExport = async () => {
		setStarting(true);
		setError(null);
		try {
			const approved =
				chosen === "approved" && checkpoint
					? checkpoint
					: (await finalizeCut({ editor, origin: "export" })).checkpoint;
			await onExport(
				checkpointDeliverySnapshot({ editor, checkpoint: approved }),
			);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setStarting(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			{differs && checkpoint && (
				<RadioGroup
					value={chosen}
					onValueChange={(value) => {
						if (value === "current" || value === "approved") setVersion(value);
					}}
					aria-label="Which edit to export"
					className="gap-1.5"
				>
					<div className="flex items-center gap-2">
						<RadioGroupItem value="current" id="export-version-current" />
						<Label
							htmlFor="export-version-current"
							className="text-xs font-normal"
						>
							Current edit, approving it now
						</Label>
					</div>
					<div className="flex items-center gap-2">
						<RadioGroupItem value="approved" id="export-version-approved" />
						<Label
							htmlFor="export-version-approved"
							className="text-xs font-normal"
						>
							Approved cut from {formatApproved(checkpoint)}
						</Label>
					</div>
				</RadioGroup>
			)}
			{blocking.length > 0 ? (
				<section
					aria-label="Issues before export"
					className="flex flex-col gap-1.5"
				>
					<p className="text-xs font-medium" role="status">
						Fix or dismiss {blocking.length} issue(s) to export. Select one to
						play its passage.
					</p>
					<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
						{blocking.map((issue) => (
							<IssueRow key={issue.id} issue={issue} />
						))}
					</ul>
				</section>
			) : (
				chosen === "current" && (
					<p className="text-muted-foreground text-xs">
						Exporting approves this exact edit.
					</p>
				)
			)}
			{error && (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			)}
			<Button
				onClick={handleExport}
				className="w-full gap-2"
				disabled={disabled || starting || blocking.length > 0}
			>
				{starting ? <Spinner /> : <Download className="size-4" />}
				{chosen === "approved" ? "Export approved cut" : "Approve and export"}
			</Button>
		</div>
	);
}
