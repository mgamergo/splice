"use client";

import { useEffect, useId, useRef, useState } from "react";
import { isFootagePath } from "@splice/bridge";
import type { RelinkItemResult } from "@splice/bridge/items";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { useEditor } from "@/editor/use-editor";
import type { DiskMedia, ProjectItem } from "./types";

export function RelinkDialog({
	item,
	file,
	onClose,
}: {
	item: ProjectItem;
	file: DiskMedia;
	onClose: () => void;
}) {
	const editor = useEditor();
	const pathId = useId();
	const [path, setPath] = useState(file.path);
	const [pending, setPending] = useState(false);
	const [committing, setCommitting] = useState(false);
	const [progress, setProgress] = useState<number>();
	const abortRef = useRef<AbortController | null>(null);
	useEffect(() => () => abortRef.current?.abort(), []);
	const cancel = () => {
		abortRef.current?.abort();
		onClose();
	};
	const [error, setError] = useState("");
	const [confirmation, setConfirmation] = useState<Extract<
		RelinkItemResult,
		{ kind: "confirmation-required" }
	> | null>(null);
	const submit = async () => {
		const abort = new AbortController();
		abortRef.current = abort;
		setPending(true);
		setProgress(undefined);
		setError("");
		try {
			const result = await editor.media.relinkRecording({
				signal: abort.signal,
				onProgress: setProgress,
				beforeCommit: () => setCommitting(true),
				request: {
					projectItemId: item.id,
					path: path.trim(),
					replace: confirmation !== null,
					expectedVersion: confirmation?.version,
				},
			});
			if (result.kind === "confirmation-required") {
				setConfirmation(result);
			} else {
				toast.success(
					result.verification === "match"
						? "Recording relinked"
						: "Replacement linked. Review the affected passages.",
				);
				onClose();
			}
		} catch (failure) {
			if (abort.signal.aborted) return;
			setError(failure instanceof Error ? failure.message : String(failure));
			setConfirmation(null);
		} finally {
			abortRef.current = null;
			setCommitting(false);
			setPending(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !committing) cancel();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Relink recording</DialogTitle>
					<DialogDescription>{item.name}</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<DialogBody>
						<label htmlFor={pathId}>Path inside Footage</label>
						<Input
							id={pathId}
							value={path}
							disabled={pending}
							onChange={(event) => {
								setPath(event.target.value);
								setConfirmation(null);
								setError("");
							}}
						/>
						{confirmation && (
							<p role="status">
								{confirmation.verification === "changed"
									? "This file differs from the original recording."
									: "Splice could not verify this file against the original recording."}
								{
									" Your edits will stay in place and the project’s undo history will be cleared. Review the affected passages after replacing the recording."
								}
							</p>
						)}
						{pending && progress !== undefined && (
							<progress
								aria-label="Checking recording contents"
								max={100}
								value={progress}
							/>
						)}
						{error && <p role="alert">{error}</p>}
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={cancel}
							disabled={committing}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={pending || !isFootagePath(path.trim())}
						>
							{pending
								? "Checking…"
								: confirmation
									? "Use as replacement"
									: "Verify and relink"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
