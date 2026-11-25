"use client";

import { FolderOpen, GitCompare, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLibraryPanelStore } from "@/components/editor/panels/library/library-panel-store";
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
import { useEditor } from "@/editor/use-editor";
import { toast } from "sonner";
import { openExportsFolder } from "@/export/deliver";
import { projectFormat } from "@/project/format";
import { mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { projectApproval } from "../checkpoint";
import { describeChanges } from "../compare";
import {
	useApprovalSpellings,
	useProjectExports,
	useReviewState,
} from "../hooks";
import { watchApprovedCut } from "../playback";
import { formatTime } from "./issue-row";
import { formatApproved } from "./review-panel";

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-0.5 border-b py-2 text-sm last:border-b-0">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="break-words">{children}</span>
		</div>
	);
}

/**
 * On opening a project that was approved or exported before: the current
 * edit, the last approved checkpoint, what changed since, and which edit the
 * latest export used, with playback, comparison and the exported files.
 */
export function ReopenSummary() {
	const editor = useEditor();
	const project = useEditor((e) => e.project.getActiveOrNull());
	const sequenceId = useEditor(
		(e) => e.sequences.getActiveSequenceOrNull()?.id,
	);
	const { exports, error } = useProjectExports();
	const horizontal = !!project && projectFormat({ project }) === "horizontal";
	const spellings = useApprovalSpellings({ enabled: horizontal });
	const ready = !horizontal || spellings.ready || !!spellings.error;
	const shown = useRef(false);
	const setActiveTab = useLibraryPanelStore((state) => state.setActiveTab);
	const [open, setOpen] = useState(false);
	const review = useReviewState({ enabled: open });
	const projectId = project?.metadata.id;
	const checkpoints = projectApproval(project).checkpoints;

	useEffect(() => {
		if (
			!ready ||
			!projectId ||
			!review ||
			(exports === null && !error) ||
			shown.current
		)
			return;
		shown.current = true;
		if (checkpoints.length > 0 || (exports?.length ?? 0) > 0) setOpen(true);
	}, [ready, projectId, sequenceId, exports, error, checkpoints.length]);

	if (!open || !review || !project) return null;
	const { sequence, comparison, unresolved } = review;
	const checkpoint = review.checkpoint ?? checkpoints.at(-1);
	const latest = exports?.[0];
	const exportedCheckpoint = checkpoints.find(
		({ id }) => id === latest?.checkpointId,
	);
	const duration = editor.timeline.getTotalDuration();

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader>
					<DialogTitle>Welcome back to {project.metadata.name}</DialogTitle>
					<DialogDescription>Where this edit stands.</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col">
					<Row label="Current edit">
						{sequence.name} ·{" "}
						{formatTime(mediaTimeToSeconds({ time: duration }))} · Revision{" "}
						{editor.command.getRevision()}
					</Row>
					<Row label="Last approved">
						{checkpoint
							? `${checkpoint.sequenceName} · ${formatApproved(checkpoint)} · Revision ${checkpoint.revision}${checkpoint.note ? ` · “${checkpoint.note}”` : ""}`
							: "Not finalized yet"}
					</Row>
					{checkpoint && comparison && (
						<Row label="Since approval">
							{comparison.identical
								? "No changes: the current edit is the approved cut."
								: `${comparison.passages.length} passage(s) changed: ${describeChanges(comparison.changes)}.`}
							{unresolved.length > 0 &&
								` ${unresolved.length} issue(s) to review before export.`}
						</Row>
					)}
					<Row label="Latest export">
						{latest ? (
							<>
								{latest.sequenceName} · Revision {latest.revision} ·{" "}
								{new Date(latest.exportedAt).toLocaleString()}
								{exportedCheckpoint &&
									" · Approved " + formatApproved(exportedCheckpoint)}
								{!latest.present && " (files moved or deleted)"}
							</>
						) : (
							(error ?? "None yet")
						)}
					</Row>
				</DialogBody>
				<DialogFooter className="flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={() => {
							setOpen(false);
							editor.playback.seek({ time: ZERO_MEDIA_TIME });
							editor.playback.play();
						}}
					>
						<Play />
						Play current edit
					</Button>
					{checkpoint && comparison && !comparison.identical && (
						<Button
							variant="outline"
							onClick={() => {
								setOpen(false);
								setActiveTab("review");
							}}
						>
							<GitCompare />
							Compare with approved
						</Button>
					)}
					{checkpoint && (
						<Button
							variant="outline"
							onClick={() => {
								setOpen(false);
								setActiveTab("review");
								watchApprovedCut({ editor, checkpoint });
							}}
						>
							<Play />
							Watch approved cut
						</Button>
					)}
					{latest && (
						<Button
							variant="outline"
							onClick={async () => {
								try {
									const { opened, folder } = await openExportsFolder();
									if (!opened) toast.info(folder);
								} catch (failure) {
									toast.error(
										failure instanceof Error
											? failure.message
											: String(failure),
									);
								}
							}}
						>
							<FolderOpen />
							Open exports
						</Button>
					)}
					<Button onClick={() => setOpen(false)}>Continue editing</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
