import { referencedMedia } from "./sequence-media";
import type { TProject } from "@/project/types";
import type { TSequence } from "@/timeline/types";

/** Keep edits and corrections. Drop words and derived mix evidence from the old recording. */
export function invalidateRecordingAnalysis({
	project,
	sequences,
	projectItemId,
}: {
	project: TProject;
	sequences: TSequence[];
	projectItemId: string;
}) {
	const otherSources = <T extends { projectItemId: string }>({
		sources,
	}: {
		sources: T[];
	}) => sources.filter((source) => source.projectItemId !== projectItemId);
	const captions = project.captions && {
		...project.captions,
		sources: otherSources(project.captions),
	};
	const updatedSequences = sequences.map((sequence) => {
		const music = sequence.mix?.music;
		const fit = music?.fit;
		const usesRecording = referencedMedia({ tracks: sequence.tracks }).has(
			projectItemId,
		);
		return {
			...sequence,
			captions: sequence.captions && {
				...sequence.captions,
				sources: otherSources(sequence.captions),
			},
			mix: sequence.mix && {
				...sequence.mix,
				...(music &&
					fit && {
						music: { ...music, fit: { ...fit, sources: otherSources(fit) } },
					}),
				...(usesRecording && { loudness: undefined }),
			},
		};
	});
	return { captions, sequences: updatedSequences };
}
