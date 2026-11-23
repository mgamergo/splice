import { useState } from "react";
import {
	EditRemovalMarkerCommand,
	type RemovalMarkerEdit,
} from "@/commands/sequence/edit-removal-marker";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/editor/use-editor";
import type { RemovalMarker } from "@/timeline/types";
import { RemovalTakeError, takeRanges } from "../removal-takes";

export function RemovalMarkerPopover({ marker }: { marker: RemovalMarker }) {
	const editor = useEditor();
	const [error, setError] = useState<string>();
	const { sectionName, badTakes } = marker.data;

	const apply = (edit: RemovalMarkerEdit) => {
		setError(undefined);
		try {
			editor.command.execute({
				command: new EditRemovalMarkerCommand({ editor, edit }),
			});
		} catch (cause) {
			if (!(cause instanceof RemovalTakeError)) throw cause;
			setError(cause.message);
		}
	};

	return (
		<>
			<h3 className="break-words text-sm font-medium">{sectionName}</h3>
			<ul className="max-h-64 space-y-2 overflow-y-auto">
				{badTakes.map((take, index) => {
					const label = take.label || `Take ${index + 1}`;
					return (
						<li
							key={JSON.stringify(
								takeRanges(take).map(
									({ projectItemId, sourceIn, sourceOut }) => [
										projectItemId,
										sourceIn,
										sourceOut,
									],
								),
							)}
							className="flex flex-col gap-1.5 border-t pt-2"
						>
							<div className="break-words text-xs font-medium">{label}</div>
							{take.transcriptSnippet && (
								<p className="line-clamp-3 break-words text-xs text-muted-foreground">
									{take.transcriptSnippet}
								</p>
							)}
							<div className="flex gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									aria-label={`Restore ${label}`}
									onClick={() =>
										apply({
											op: "restore_takes",
											markerId: marker.id,
											takeIndex: index,
										})
									}
								>
									Restore
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									aria-label={`Swap in ${label}`}
									onClick={() =>
										apply({
											op: "swap_take",
											markerId: marker.id,
											takeIndex: index,
										})
									}
								>
									Swap
								</Button>
							</div>
						</li>
					);
				})}
			</ul>
			{badTakes.length > 1 && (
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => apply({ op: "restore_takes", markerId: marker.id })}
				>
					Restore all
				</Button>
			)}
			{error && (
				<p role="alert" className="break-words text-xs text-destructive">
					{error}
				</p>
			)}
		</>
	);
}
