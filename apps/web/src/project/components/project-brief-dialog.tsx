"use client";

import { useId, useState } from "react";
import { briefSetRequestSchema } from "@splice/bridge/brief";
import { EditorApi } from "@/agent/editor-api";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEditor } from "@/editor/use-editor";

const textFields = [
	{ name: "audience", label: "Audience" },
	{ name: "goal", label: "Goal" },
	{ name: "tone", label: "Tone" },
] as const;

export function ProjectBriefDialog() {
	const editor = useEditor();
	const api = new EditorApi(editor);
	const project = useEditor((core) => core.project.getActive());
	const [draft, setDraft] = useState<{
		projectId: string;
		expectedRevision: number;
		brief: typeof project.brief;
	} | null>(null);
	const [error, setError] = useState("");
	const id = useId();

	function setOpen(open: boolean) {
		setError("");
		setDraft(
			open
				? {
						projectId: project.metadata.id,
						expectedRevision: api.getRevision(),
						brief: project.brief,
					}
				: null,
		);
	}

	function save(form: HTMLFormElement) {
		if (!draft) return;
		const data = new FormData(form);
		const field = (name: string) => String(data.get(name) ?? "").trim();
		const duration = field("targetDurationSeconds");
		const parsed = briefSetRequestSchema.safeParse({
			projectId: draft.projectId,
			expectedRevision: draft.expectedRevision,
			brief: {
				text: field("text"),
				audience: field("audience") || undefined,
				goal: field("goal") || undefined,
				tone: field("tone") || undefined,
				targetDurationSeconds: duration ? Number(duration) : undefined,
				mustKeepPoints: field("mustKeepPoints")
					.split(/\r?\n/)
					.map((point) => point.trim())
					.filter(Boolean),
			},
		});
		if (!parsed.success) {
			setError(parsed.error.issues[0].message);
			return;
		}
		const result = api.briefSet(parsed.data);
		if (result.ok) setOpen(false);
		else
			setError(
				result.code === "REVISION_CONFLICT"
					? "The project changed while the brief was open. Copy any unsaved notes, then reopen the brief."
					: result.message,
			);
	}

	return (
		<Dialog open={draft !== null} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="ghost" size="sm">
					Project brief
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-auto">
				<DialogHeader>
					<DialogTitle>Project brief</DialogTitle>
					<DialogDescription>
						Optional direction for this edit. Leave fields blank to clear them.
					</DialogDescription>
				</DialogHeader>
				{draft && (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							save(event.currentTarget);
						}}
					>
						<DialogBody>
							<div className="grid gap-2">
								<Label htmlFor={`${id}-text`}>Editing notes</Label>
								<Textarea
									id={`${id}-text`}
									name="text"
									rows={3}
									maxLength={8000}
									defaultValue={draft.brief?.text}
								/>
							</div>
							<div className="grid gap-4 sm:grid-cols-2">
								{textFields.map(({ name, label }) => (
									<div key={name} className="grid gap-2">
										<Label htmlFor={`${id}-${name}`}>{label}</Label>
										<Input
											id={`${id}-${name}`}
											name={name}
											maxLength={500}
											defaultValue={draft.brief?.[name]}
										/>
									</div>
								))}
								<div className="grid gap-2">
									<Label htmlFor={`${id}-duration`}>
										Target duration (seconds)
									</Label>
									<Input
										id={`${id}-duration`}
										name="targetDurationSeconds"
										type="number"
										step="any"
										min={0}
										defaultValue={draft.brief?.targetDurationSeconds}
									/>
								</div>
							</div>
							<div className="grid gap-2">
								<Label htmlFor={`${id}-points`}>Must-keep points</Label>
								<Textarea
									id={`${id}-points`}
									name="mustKeepPoints"
									rows={2}
									placeholder="One point per line"
									defaultValue={draft.brief?.mustKeepPoints?.join("\n")}
								/>
							</div>
							{error && (
								<p role="alert" className="text-destructive text-sm">
									{error}
								</p>
							)}
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button type="submit">Save brief</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
