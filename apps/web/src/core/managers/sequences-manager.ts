import type { EditorCore } from "@/core";
import type { Marker, SequenceTracks, TSequence } from "@/timeline";
import { storageService } from "@/services/storage/service";
import {
	getMainSequence,
	ensureMainSequence,
	canDeleteSequence,
	findCurrentSequence,
} from "@/timeline/sequences";
import {
	getMarkerAtTime,
	getFrameTime,
	isMarkerAtTime,
} from "@/timeline/markers/index";
import {
	CreateSequenceCommand,
	DeleteSequenceCommand,
	MoveMarkerCommand,
	RemoveMarkerCommand,
	RenameSequenceCommand,
	ToggleMarkerCommand,
	UpdateMarkerCommand,
} from "@/commands/sequence";
import type { MediaTime } from "@/wasm";

export class SequencesManager {
	private active: TSequence | null = null;
	private list: TSequence[] = [];
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	async createSequence({
		name,
		isMain = false,
	}: {
		name: string;
		isMain: boolean;
	}): Promise<string> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new CreateSequenceCommand({ name, isMain });
		this.editor.command.execute({ command });
		return command.getSequenceId();
	}

	async deleteSequence({ sequenceId }: { sequenceId: string }): Promise<void> {
		const sequenceToDelete = this.list.find((s) => s.id === sequenceId);

		if (!sequenceToDelete) {
			throw new Error("Sequence not found");
		}

		const { canDelete, reason } = canDeleteSequence({
			sequence: sequenceToDelete,
		});
		if (!canDelete) {
			throw new Error(reason);
		}

		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new DeleteSequenceCommand(sequenceId);
		this.editor.command.execute({ command });
	}

	async renameSequence({
		sequenceId,
		name,
	}: {
		sequenceId: string;
		name: string;
	}): Promise<void> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new RenameSequenceCommand({
			sequenceId,
			newName: name,
		});
		this.editor.command.execute({ command });
	}

	async switchToSequence({
		sequenceId,
	}: {
		sequenceId: string;
	}): Promise<void> {
		const targetSequence = this.list.find((s) => s.id === sequenceId);

		if (!targetSequence) {
			throw new Error("Sequence not found");
		}

		const activeProject = this.editor.project.getActive();

		if (activeProject) {
			const updatedProject = {
				...activeProject,
				currentSequenceId: sequenceId,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};

			this.editor.project.setActiveProject({ project: updatedProject });
		}

		const changed = this.active?.id !== targetSequence.id;
		this.active = targetSequence;
		this.notify();
		if (changed) this.editor.command.bumpRevision();
	}

	async toggleMarker({ time }: { time: MediaTime }): Promise<void> {
		const command = new ToggleMarkerCommand(time);
		this.editor.command.execute({ command });
	}

	isMarkered({ time }: { time: MediaTime }): boolean {
		const activeSequence = this.getActiveSequence();
		const activeProject = this.editor.project.getActive();

		if (!activeSequence || !this.active || !activeProject) return false;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return isMarkerAtTime({ markers: activeSequence.markers, frameTime });
	}

	async removeMarker({ time }: { time: MediaTime }): Promise<void> {
		const command = new RemoveMarkerCommand(time);
		this.editor.command.execute({ command });
	}

	async updateMarker({
		time,
		updates,
	}: {
		time: MediaTime;
		updates: Partial<Pick<Marker, "note" | "color" | "duration">>;
	}): Promise<void> {
		const command = new UpdateMarkerCommand({ time, updates });
		this.editor.command.execute({ command });
	}

	async moveMarker(move: {
		fromTime: MediaTime;
		toTime: MediaTime;
		markerId?: string;
	}): Promise<void> {
		const command = new MoveMarkerCommand(move);
		this.editor.command.execute({ command });
	}

	getMarkerAtTime({ time }: { time: MediaTime }) {
		const activeSequence = this.active;
		const activeProject = this.editor.project.getActive();

		if (!activeSequence || !activeProject) return null;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return getMarkerAtTime({
			markers: activeSequence.markers,
			frameTime,
		});
	}

	async loadProjectSequences({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		try {
			const result = await storageService.loadProject({ id: projectId });
			if (result?.project.sequences) {
				const ensuredSequences = result.project.sequences ?? [];
				const currentSequence = findCurrentSequence({
					sequences: ensuredSequences,
					currentSequenceId: result.project.currentSequenceId,
				});

				this.list = ensuredSequences;
				this.active = currentSequence;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to load project sequences:", error);
			this.list = [];
			this.active = null;
			this.notify();
		}
	}

	initializeSequences({
		sequences,
		currentSequenceId,
	}: {
		sequences: TSequence[];
		currentSequenceId?: string;
	}): void {
		const ensuredSequences = ensureMainSequence({ sequences });
		const currentSequence = currentSequenceId
			? ensuredSequences.find((s) => s.id === currentSequenceId)
			: null;

		const fallbackSequence = getMainSequence({ sequences: ensuredSequences });

		this.list = ensuredSequences;
		this.active = currentSequence || fallbackSequence;
		this.notify();

		const hasAddedMainSequence = ensuredSequences.length > sequences.length;
		if (hasAddedMainSequence) {
			const activeProject = this.editor.project.getActive();

			if (activeProject) {
				const updatedProject = {
					...activeProject,
					sequences: ensuredSequences,
					metadata: {
						...activeProject.metadata,
						updatedAt: new Date(),
					},
				};

				this.editor.project.setActiveProject({ project: updatedProject });
				this.editor.save.markDirty({ force: true });
			}
		}
	}

	clearSequences(): void {
		this.list = [];
		this.active = null;
		this.notify();
	}

	getActiveSequence(): TSequence {
		if (!this.active) {
			throw new Error("No active sequence.");
		}
		return this.active;
	}

	getActiveSequenceOrNull(): TSequence | null {
		return this.active;
	}

	getSequences(): TSequence[] {
		return this.list;
	}

	setSequences({
		sequences,
		activeSequenceId,
	}: {
		sequences: TSequence[];
		activeSequenceId?: string;
	}): void {
		this.list = sequences;
		const nextActiveSequenceId = activeSequenceId ?? this.active?.id ?? null;
		this.active = nextActiveSequenceId
			? (sequences.find((sequence) => sequence.id === nextActiveSequenceId) ??
				null)
			: null;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				sequences,
				currentSequenceId: this.active?.id ?? activeProject.currentSequenceId,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	updateSequenceTracks({ tracks }: { tracks: SequenceTracks }): void {
		if (!this.active) return;

		const updatedSequence: TSequence = {
			...this.active,
			tracks,
			updatedAt: new Date(),
		};

		this.list = this.list.map((s) =>
			s.id === this.active?.id ? updatedSequence : s,
		);
		this.active = updatedSequence;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				sequences: this.list,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}
}
