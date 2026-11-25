"use client";

import type { ReviewIssue } from "@splice/bridge/approval";
import { RotateCcw, X } from "lucide-react";
import { findGraphicClip } from "@/agent/graphics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import { dismissIssue, undismissIssue } from "../checkpoint";
import { playPassage } from "../playback";

export function formatTime(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	const rest = seconds - minutes * 60;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** One review issue: select it to play the surrounding edit, or dismiss it. */
export function IssueRow({
	issue,
	onPlay,
}: {
	issue: ReviewIssue;
	onPlay?: () => void;
}) {
	const editor = useEditor();
	const { dismissed } = issue;
	const play =
		onPlay ??
		(() => {
			if (issue.graphicId) {
				const sequence = editor.sequences.getActiveSequence();
				const placed = findGraphicClip({
					tracks: sequence.tracks,
					graphicId: issue.graphicId,
				});
				if (placed)
					editor.selection.setSelectedClips({
						clips: [{ trackId: placed.trackId, clipId: placed.clip.id }],
					});
			}
			playPassage({ editor, start: issue.start, end: issue.end });
		});
	return (
		<li
			className="flex items-start gap-1 rounded-md border p-1.5 text-xs"
			data-issue-id={issue.id}
		>
			<button
				type="button"
				className="min-w-0 flex-1 cursor-pointer rounded-sm px-1 py-0.5 text-left"
				onClick={play}
				aria-label={`${issue.title} at ${formatTime(issue.start)}. Play the surrounding edit.`}
			>
				<span className="flex flex-wrap items-center gap-1.5">
					<span className="font-medium">{issue.title}</span>
					<span className="text-muted-foreground tabular-nums">
						{formatTime(issue.start)}
					</span>
					{dismissed && (
						<Badge variant="outline" className="px-1.5 py-0 text-[0.65rem]">
							Dismissed{dismissed.by === "agent" ? " by the agent" : ""}
						</Badge>
					)}
				</span>
				<span className="text-muted-foreground block break-words">
					{issue.detail}
				</span>
			</button>
			<div className="flex shrink-0 flex-col gap-0.5">
				{dismissed ? (
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={`Bring back ${issue.title}`}
						onClick={() => undismissIssue({ editor, issueId: issue.id })}
					>
						<RotateCcw />
					</Button>
				) : (
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						aria-label={`Dismiss ${issue.title}`}
						onClick={() =>
							dismissIssue({
								editor,
								issueId: issue.id,
								evidence: issue.evidence,
								by: "creator",
							})
						}
					>
						<X />
					</Button>
				)}
			</div>
		</li>
	);
}
