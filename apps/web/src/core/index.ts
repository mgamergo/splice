import { PlaybackManager } from "./managers/playback-manager";
import { TimelineManager } from "./managers/timeline-manager";
import { SequencesManager } from "./managers/sequences-manager";
import { ProjectManager } from "./managers/project-manager";
import { MediaManager } from "./managers/media-manager";
import { RendererManager } from "./managers/renderer-manager";
import { CommandManager } from "./managers/commands";
import { SaveManager } from "./managers/save-manager";
import { AudioManager } from "./managers/audio-manager";
import { SelectionManager } from "./managers/selection-manager";
import { ClipboardManager } from "./managers/clipboard-manager";
import { DiagnosticsManager } from "./managers/diagnostics-manager";
import { registerDefaultEffects } from "@/effects";
import { registerDefaultMasks } from "@/masks";
import { registerTranscriptionDiagnostics } from "@/transcription/diagnostics";
import { graphicsFollowUp } from "@/agent/graphics-follow-up";

export class EditorCore {
	private static instance: EditorCore | null = null;
	public readonly timeline: TimelineManager;
	public readonly command: CommandManager;
	public readonly playback: PlaybackManager;
	public readonly sequences: SequencesManager;
	public readonly project: ProjectManager;
	public readonly media: MediaManager;
	public readonly renderer: RendererManager;
	public readonly save: SaveManager;
	public readonly audio: AudioManager;
	public readonly selection: SelectionManager;
	public readonly clipboard: ClipboardManager;
	public readonly diagnostics: DiagnosticsManager;

	private constructor() {
		registerDefaultEffects();
		registerDefaultMasks();
		this.command = new CommandManager(this);
		this.timeline = new TimelineManager(this);
		this.playback = new PlaybackManager(this);
		this.sequences = new SequencesManager(this);
		this.project = new ProjectManager(this);
		this.media = new MediaManager(this);
		this.renderer = new RendererManager(this);
		this.save = new SaveManager({ editor: this });
		this.audio = new AudioManager(this);
		this.selection = new SelectionManager(this);
		this.clipboard = new ClipboardManager(this);
		this.diagnostics = new DiagnosticsManager(this);
		registerTranscriptionDiagnostics({ diagnostics: this.diagnostics });
		this.playback.bindTimelineScope();
		this.command.registerFollowUp((command) =>
			graphicsFollowUp({ editor: this, recordFraming: !command.isAgentEdit }),
		);
		this.command.registerReactor(() => {
			const activeSequence = this.sequences.getActiveSequenceOrNull();
			if (!activeSequence) {
				return;
			}

			const tracks = activeSequence.tracks;
			const storedTakeTrackIds = new Set(
				activeSequence.markers.flatMap(
					({ data }) =>
						data?.badTakePlacements?.flatMap(
							(placements) =>
								placements?.flatMap(
									({ trackId, audioTrackId, audioSegments }) => [
										trackId,
										...(audioTrackId ? [audioTrackId] : []),
										...(audioSegments?.flatMap((segment) =>
											segment.audioTrackId ? [segment.audioTrackId] : [],
										) ?? []),
									],
								) ?? [],
						) ?? [],
				),
			);
			const keepTrack = (track: { id: string; clips: unknown[] }) =>
				track.clips.length > 0 || storedTakeTrackIds.has(track.id);
			const prunedTracks = {
				...tracks,
				overlay: tracks.overlay.filter(keepTrack),
				audio: tracks.audio.filter(keepTrack),
			};
			if (
				prunedTracks.overlay.length !== tracks.overlay.length ||
				prunedTracks.audio.length !== tracks.audio.length
			) {
				this.timeline.updateTracks(prunedTracks);
			}
		});
		this.save.start();
	}

	static getInstance(): EditorCore {
		if (!EditorCore.instance) {
			EditorCore.instance = new EditorCore();
			exposeForBenchmark(EditorCore.instance);
		}
		return EditorCore.instance;
	}

	static reset(): void {
		EditorCore.instance = null;
	}
}

/**
 * `bun run bench` drives exports through the editor core. It sets
 * `localStorage["splice:bench"]`; ordinary sessions never expose the core.
 */
function exposeForBenchmark(editor: EditorCore): void {
	try {
		if (
			typeof window !== "undefined" &&
			window.localStorage.getItem("splice:bench") === "1"
		)
			Object.assign(window, { __spliceEditor: editor });
	} catch {
		// Storage can be blocked; the benchmark then can't run, nothing else changes.
	}
}
