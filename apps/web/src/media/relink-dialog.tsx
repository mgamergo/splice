"use client";

import { useId, useState } from "react";
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
	const [error, setError] = useState("");
	const [confirmation, setConfirmation] = useState<Extract<
		RelinkItemResult,
		{ kind: "confirmation-required" }
	> | null>(null);
	const submit = async () => {
		setPending(true);
		setError("");
		try {
			const result = await editor.media.relinkRecording({
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
			setError(failure instanceof Error ? failure.message : String(failure));
			setConfirmation(null);
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !pending) onClose();
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
									" Your edits will stay in place. Review the affected passages after replacing the recording."
								}
							</p>
						)}
						{error && <p role="alert">{error}</p>}
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={pending}
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
