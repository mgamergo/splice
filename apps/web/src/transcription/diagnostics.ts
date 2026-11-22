import type { DiagnosticsManager } from "@/core/managers/diagnostics-manager";
import { timelineHasAudio } from "@/media/audio";

export const TRANSCRIPTION_DIAGNOSTICS_SCOPE = "transcription";

export function registerTranscriptionDiagnostics({
	diagnostics,
}: {
	diagnostics: DiagnosticsManager;
}): void {
	diagnostics.register({
		id: "transcription.no_audio",
		scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE,
		severity: "caution",
		message: "No audio detected. Add a clip with audio to the timeline first.",
		check: (editor) => {
			const sequence = editor.sequences.getActiveSequenceOrNull();
			if (!sequence) return false;
			return !timelineHasAudio({
				tracks: sequence.tracks,
				projectItems: editor.media.getProjectItems(),
			});
		},
	});
}
