import type { ProjectCaptions } from "@splice/bridge/delivery";
import { Command } from "@/commands/base-command";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";

/** Replaces a project's SRT captions (words and corrections) as one undo step. */
export class UpdateProjectCaptionsCommand extends Command {
	readonly ignoresRippleToggle = true;
	private before: TProject | null = null;

	constructor(
		private readonly options: {
			editor: EditorCore;
			captions: ProjectCaptions;
			label: string;
		},
	) {
		super();
	}

	get label(): string {
		return this.options.label;
	}

	execute(): undefined {
		const { editor, captions } = this.options;
		const project = editor.project.getActiveOrNull();
		if (!project) return;
		this.before = project;
		editor.project.setActiveProject({ project: { ...project, captions } });
		editor.save.markDirty();
	}

	undo(): void {
		const { editor } = this.options;
		const project = editor.project.getActiveOrNull();
		if (!project || !this.before) return;
		editor.project.setActiveProject({
			project: { ...project, captions: this.before.captions },
		});
		editor.save.markDirty();
	}
}
