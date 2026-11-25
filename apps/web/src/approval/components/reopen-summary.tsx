"use client";

import { FolderOpen, GitCompare, Play } from "lucide-react";
import { useEffect, useState } from "react";
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
import { openExportsFolder } from "@/export/deliver";
import { mediaTimeToSeconds, ZERO_MEDIA_TIME } from "@/wasm";
import { projectApproval } from "../checkpoint";
import { describeChanges } from "../compare";
import {
	useCurrentFingerprint,
	useProjectExports,
	useReviewState,
} from "../hooks";
import { openApprovedCut } from "../playback";
import { exportedEdit } from "../review";
import { formatTime } from "./issue-row";
import { formatApproved } from "./review-panel";

/** Projects whose summary showed since the editor loaded. */
const shown = new Set<string>();

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
	const review = useReviewState();
	const { exports } = useProjectExports();
	const currentFingerprint = useCurrentFingerprint();
	const setActiveTab = useLibraryPanelStore((state) => state.setActiveTab);
	const [open, setOpen] = useState(false);
	const projectId = project?.metadata.id;
	const checkpoints = projectApproval(project).checkpoints;

	useEffect(() => {
		if (!projectId || !review || exports === null || shown.has(projectId))
			return;
		shown.add(projectId);
		if (checkpoints.length > 0 || exports.length > 0) setOpen(true);
	}, [projectId, review, exports, checkpoints.length]);

	if (!open || !review || !project) return null;
	const { sequence, checkpoint, comparison, unresolved } = review;
	const latest = exports?.[0];
	const used = latest
		? exportedEdit({
				fingerprint: latest.fingerprint,
				currentFingerprint,
				checkpoints,
			})
		: null;
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
						{formatTime(mediaTimeToSeconds({ time: duration }))}
					</Row>
					<Row label="Last approved">
						{checkpoint
							? `${formatApproved(checkpoint)}${checkpoint.note ? ` · “${checkpoint.note}”` : ""}`
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
						{latest && used
							? `${new Date(latest.exportedAt).toLocaleString()} · ${
									used.current
										? "the current edit"
										: used.checkpoint
											? `the cut approved ${formatApproved(used.checkpoint)}`
											: "an earlier edit"
								}${latest.present ? "" : " (files moved or deleted)"}`
							: "None yet"}
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
								void openApprovedCut({ editor, checkpoint });
							}}
						>
							<Play />
							Watch approved cut
						</Button>
					)}
					{latest && (
						<Button
							variant="outline"
							onClick={() => void openExportsFolder().catch(() => {})}
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
