import {
	buildRawSequence,
	buildRoughCut,
	playedClips,
	RAW_SEQUENCE_NAME,
	sequenceDurationSeconds,
} from "@/agent/rough-cut";
import { AddPreparedSequenceCommand } from "@/commands/sequence/add-prepared-sequence";
import {
	CaptionError,
	uncaptionedItemIds as uncaptionedRecordings,
	withCaptionTrack,
	withoutCaptionTrack,
} from "@/agent/captions";
import {
	captionCuesRequestSchema,
	correctCaptionRequestSchema,
} from "@splice/bridge/delivery";
import { CaptionCorrectionError, type CaptionCue } from "@/captions/cues";
import {
	correctCaption,
	sequenceCaptionCues,
	setCaptionSources,
} from "@/captions/project-captions";
import { useCaptionsStore } from "@/captions/store";
import {
	hasTranscriptWords,
	sequenceTranscript,
} from "@/cut-transcript/sequence-transcript";
import { useTranscriptStore } from "@/cut-transcript/store";
import {
	selectedSentences,
	summarizeSelection,
	summarizeSentence,
} from "@/cut-transcript/transcript";
import {
	cutTranscriptRequestSchema,
	transcriptSelectionRequestSchema,
} from "@splice/bridge/transcript";
import { projectFormat } from "@/project/format";
import { UpdateSequenceCommand } from "@/commands/sequence/update-sequence";
import {
	applySourceGains,
	collectAudioSources,
	formatGain,
	LoudnessError,
} from "@/agent/loudness";
import { setNoiseReduction } from "@/agent/noise-reduction";
import { UpdateClipsCommand } from "@/commands/timeline/clip/update-clips";
import { isDiskMedia } from "@/media/media-data";
import { canClipHaveAudio, hasMediaId } from "@/timeline/clip-utils";
import { hasAnimatedVolume } from "@/timeline/audio-state";
import { buildSequenceDigest } from "@/agent/digest";
import type { RoughCutSources } from "@splice/bridge";
import {
	type ApplyRequest,
	applyRequestSchema,
	addCaptionsRequestSchema,
	audioSourcesRequestSchema,
	type EditOp,
	rawSequenceRequestSchema,
	roughCutSourcesRequestSchema,
	roughCutTabRequestSchema,
	takesListRequestSchema,
} from "@splice/bridge/ops";
import { formatSeconds, resolveTimeSpec, TimeSpecError } from "@/agent/time";
import { Command, type CommandResult } from "@/commands/base-command";
import { BatchCommand } from "@/commands/batch-command";
import { EditRemovalMarkerCommand } from "@/commands/sequence/edit-removal-marker";
import {
	RemovalTakeError,
	markBestTake,
	resolveTake,
} from "@/timeline/markers/removal-takes";
import { summarizeItem } from "@/media/import-disk";
import { generateUUID } from "@/utils/id";
import { AddMarkerCommand } from "@/commands/sequence/add-marker";
import { RippleDeleteRangesCommand } from "@/commands/sequence/ripple-delete-ranges";
import { DeleteClipsCommand } from "@/commands/timeline/clip/delete-clips";
import { RazorClipsCommand } from "@/commands/timeline/clip/razor-clips";
import type { EditorCore } from "@/core";
import type {
	ClipRef,
	SequenceTracks,
	TimelineClip,
	TSequence,
} from "@/timeline";
import { addMediaTime, mediaTimeToSeconds } from "@/wasm";

export type ApplyErrorCode =
	| "INVALID_REQUEST"
	| "REVISION_CONFLICT"
	| "INVALID_OP"
	| "NO_PROJECT";

type EditorError = {
	ok: false;
	code: ApplyErrorCode;
	message: string;
	revision: number;
	/** The current digest, so the agent can re-plan after a conflict. */
	digest?: string;
};

export type ApplyResult =
	| { ok: true; revision: number; label: string; summary: string[] }
	| EditorError;

class InvalidOpError extends Error {}

function toClipRef({ trackId, clipId }: ClipRef): ClipRef {
	return { trackId, clipId };
}

function allTracks({ tracks }: { tracks: SequenceTracks }) {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

/**
 * The agent's way into the editor. Writes check the revision and enter the
 * creator's command history as one undo step.
 */
export class EditorApi {
	constructor(private readonly editor: EditorCore) {}

	getRevision(): number {
		return this.editor.command.getRevision();
	}

	getDigest(): string {
		const project = this.editor.project.getActiveOrNull();
		const sequence = this.editor.sequences.getActiveSequenceOrNull();
		if (!project || !sequence) {
			return "(no project open)";
		}
		return buildSequenceDigest({
			project,
			sequence,
			revision: this.getRevision(),
		});
	}

	apply(request: unknown): ApplyResult {
		const parsed = applyRequestSchema.safeParse(request);
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const conflict = this.checkWrite(parsed.data);
		if (conflict) return conflict;
		const activeSequenceId = this.editor.sequences.getActiveSequence().id;
		if (parsed.data.sequenceId !== activeSequenceId) {
			return {
				ok: false,
				code: "REVISION_CONFLICT",
				message: `The creator switched to another sequence (${activeSequenceId}). Re-read it and plan again.`,
				revision: this.getRevision(),
				digest: this.getDigest(),
			};
		}
		return this.run({ request: parsed.data });
	}

	rawSequence(request: unknown) {
		const parsed = rawSequenceRequestSchema.safeParse(request);
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const conflict = this.checkWrite(parsed.data);
		if (conflict) return conflict;
		if (
			this.editor.sequences
				.getSequences()
				.some(({ name }) => name === RAW_SEQUENCE_NAME)
		) {
			return this.invalidOp(
				"A sequence named Raw already exists. Use it as the source or rename it before building another.",
			);
		}
		try {
			const sequence = buildRawSequence({
				projectItemIds: parsed.data.projectItemIds,
				projectItems: this.editor.media.getProjectItems(),
			});
			return this.addPreparedSequence({
				sequence,
				label: "Agent: raw sequence",
			});
		} catch (error) {
			if (!(error instanceof RemovalTakeError)) throw error;
			return this.invalidOp(error.message);
		}
	}

	/** The sequence a rough cut copies: `sequenceId`, or the one named Raw. */
	private findRoughCutSource({
		sequenceId,
	}: {
		sequenceId?: string;
	}): TSequence | EditorError {
		const sources = this.editor.sequences
			.getSequences()
			.filter((sequence) =>
				sequenceId
					? sequence.id === sequenceId
					: sequence.name === RAW_SEQUENCE_NAME,
			);
		if (sources.length > 1)
			return this.invalidOp(
				"More than one sequence is named Raw. Pass the source sequenceId from sequence_get.",
			);
		return (
			sources[0] ??
			this.invalidOp(
				sequenceId
					? `Unknown source sequence ${sequenceId}. Read the sequence ID from sequence_get.`
					: "No sequence named Raw. Run raw_sequence or provide a source sequenceId.",
			)
		);
	}

	/**
	 * The recordings heard on a rough cut's source sequence, so `splice` can
	 * find their pauses. A recording only on muted tracks or clips, or with its
	 * audio turned off, isn't listed: its silences say nothing about what plays.
	 * Nor is a missing recording, which playback skips.
	 */
	roughCutSources(request: unknown): RoughCutSources {
		const parsed = roughCutSourcesRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const source = this.findRoughCutSource(parsed.data);
		if ("ok" in source) return source;
		const projectItems = this.editor.media.getProjectItems();
		const heard = new Set(
			playedClips({ tracks: source.tracks, projectItems }).map(
				({ clip }) => clip.mediaId,
			),
		);
		return {
			ok: true,
			sequenceId: source.id,
			items: projectItems
				.filter(({ id }) => heard.has(id))
				.map((item) => {
					const { id, name, path } = summarizeItem(item);
					return { id, name, path };
				}),
		};
	}

	roughCut(request: unknown) {
		const parsed = roughCutTabRequestSchema.safeParse(request);
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const conflict = this.checkWrite(parsed.data);
		if (conflict) return conflict;
		const {
			label = "Agent: rough cut",
			captions,
			plan,
			sourceGains,
			noiseReduction = false,
			...cutPlan
		} = parsed.data;
		const source = this.findRoughCutSource(cutPlan);
		if ("ok" in source) return source;
		const names = new Set(
			this.editor.sequences.getSequences().map(({ name }) => name),
		);
		let name = "Rough Cut";
		for (let suffix = 2; names.has(name); suffix++)
			name = `Rough Cut ${suffix}`;
		try {
			const projectItems = this.editor.media.getProjectItems();
			const cut = buildRoughCut({
				source,
				name,
				plan: cutPlan,
				projectItems,
				sliverDuration: resolveTimeSpec({
					spec: { frame: 2 },
					fps: this.editor.project.getActive().settings.fps,
				}),
			});
			// Noise reduction goes on first, so the plan reports which audio
			// `splice` must measure denoised.
			const tracks = noiseReduction
				? setNoiseReduction({
						tracks: cut.sequence.tracks,
						projectItems,
						enabled: true,
					})
				: cut.sequence.tracks;
			// A plan builds the same cut without applying it, so `splice` can
			// measure what it keeps and send the gains with the same revision.
			if (plan)
				return {
					ok: true as const,
					revision: this.getRevision(),
					audioSources: collectAudioSources({ tracks, projectItems }),
				};
			const gained = sourceGains
				? applySourceGains({ tracks, projectItems, gains: sourceGains })
				: tracks;
			const captioned = captions
				? withCaptionTrack({
						tracks: gained,
						captions,
						canvasSize: this.editor.project.getActive().settings.canvasSize,
					})
				: null;
			const sequence = captioned
				? { ...cut.sequence, tracks: captioned.tracks, captions }
				: { ...cut.sequence, tracks: gained };
			return {
				...this.addPreparedSequence({ sequence, label }),
				sections: cut.sections,
				tightening: cut.tightening,
				...(captioned && {
					captionCount: captioned.captionCount,
					uncaptionedItemIds: captioned.uncaptionedItemIds,
				}),
			};
		} catch (error) {
			if (
				!(error instanceof RemovalTakeError) &&
				!(error instanceof LoudnessError) &&
				!(error instanceof CaptionError)
			)
				throw error;
			return this.invalidOp(error.message);
		}
	}

	/** Replaces the sequence's Captions track with word-by-word captions. */
	addCaptions(request: unknown) {
		const parsed = addCaptionsRequestSchema.safeParse(request);
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const conflict = this.checkWrite(parsed.data);
		if (conflict) return conflict;
		const { sequenceId, sources, style } = parsed.data;
		const sequence = sequenceId
			? this.editor.sequences.getSequences().find(({ id }) => id === sequenceId)
			: this.editor.sequences.getActiveSequenceOrNull();
		if (!sequence)
			return this.invalidOp(
				sequenceId ? `Unknown sequence ${sequenceId}.` : "No active sequence.",
			);
		const project = this.editor.project.getActive();
		if (projectFormat({ project }) === "horizontal") {
			// Horizontal video ships a clean MP4 with a separate SRT, so its
			// captions are cues derived from the words, never burned in.
			setCaptionSources({
				editor: this.editor,
				sources,
				label: "Agent: caption words",
			});
			return {
				ok: true as const,
				sequenceId: sequence.id,
				revision: this.getRevision(),
				label: "Agent: caption words",
				captionCount: sequenceCaptionCues({ editor: this.editor, sequence })
					.length,
				uncaptionedItemIds: uncaptionedRecordings({
					content: withoutCaptionTrack({ tracks: sequence.tracks }),
					captions: { sources },
				}),
			};
		}
		try {
			const { tracks, captionCount, uncaptionedItemIds } = withCaptionTrack({
				tracks: sequence.tracks,
				captions: { sources, style },
				canvasSize: this.editor.project.getActive().settings.canvasSize,
			});
			const label = "Agent: captions";
			this.editor.command.execute({
				command: new UpdateSequenceCommand({
					editor: this.editor,
					sequenceId: sequence.id,
					updates: { tracks, captions: { sources, style } },
					label,
				}),
			});
			return {
				ok: true as const,
				sequenceId: sequence.id,
				revision: this.getRevision(),
				label,
				captionCount,
				uncaptionedItemIds,
			};
		} catch (error) {
			if (!(error instanceof CaptionError)) throw error;
			return this.invalidOp(error.message);
		}
	}

	/** The sequence a caption request names, or the active one. */
	private captionSequence({ sequenceId }: { sequenceId?: string }) {
		const project = this.editor.project.getActiveOrNull();
		if (!project)
			return {
				error: {
					ok: false as const,
					code: "NO_PROJECT" as const,
					message: "No project is open",
					revision: this.getRevision(),
				},
			};
		if (projectFormat({ project }) !== "horizontal")
			return {
				error: this.invalidOp(
					"Short projects burn their captions in. Restyle them with captions_add.",
				),
			};
		const sequence = sequenceId
			? this.editor.sequences.getSequences().find(({ id }) => id === sequenceId)
			: this.editor.sequences.getActiveSequenceOrNull();
		if (!sequence)
			return {
				error: this.invalidOp(
					sequenceId ? `Unknown sequence ${sequenceId}.` : "No active sequence.",
				),
			};
		return { sequence };
	}

	private summarizeCues(cues: CaptionCue[]) {
		return cues.map(({ words: _words, ...cue }) => cue);
	}

	/** The SRT cues of a Horizontal sequence, as the caption list shows them. */
	async captionCues(request: unknown) {
		const parsed = captionCuesRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const found = this.captionSequence(parsed.data);
		if ("error" in found) return found.error;
		await useCaptionsStore.getState().loadSpellings();
		const cues = sequenceCaptionCues({
			editor: this.editor,
			sequence: found.sequence,
		});
		return {
			ok: true as const,
			sequenceId: found.sequence.id,
			revision: this.getRevision(),
			cues: this.summarizeCues(cues),
			...(!this.editor.project.getActive().captions?.sources.length && {
				hint: "No caption words yet. Transcribe the recordings, then run captions_add.",
			}),
		};
	}

	/** Corrects one cue, the same words across the project, or saves a reusable spelling. */
	async correctCaption(request: unknown) {
		const parsed = correctCaptionRequestSchema.safeParse(request);
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const conflict = this.checkWrite(parsed.data);
		if (conflict) return conflict;
		const found = this.captionSequence(parsed.data);
		if ("error" in found) return found.error;
		const { cueId, text, scope } = parsed.data;
		await useCaptionsStore.getState().loadSpellings();
		const cue = sequenceCaptionCues({
			editor: this.editor,
			sequence: found.sequence,
		}).find(({ id }) => id === cueId);
		if (!cue)
			return this.invalidOp(
				`No cue ${cueId} on this sequence. Read captions_list again.`,
			);
		try {
			const { replacement } = await correctCaption({
				editor: this.editor,
				cue,
				text,
				scope,
			});
			return {
				ok: true as const,
				revision: this.getRevision(),
				scope,
				...(replacement && { replaced: replacement }),
				cues: this.summarizeCues(
					sequenceCaptionCues({ editor: this.editor, sequence: found.sequence }),
				).filter(
					(summary) =>
						summary.start < cue.end + 10 && summary.end > cue.start - 10,
				),
			};
		} catch (error) {
			if (!(error instanceof CaptionCorrectionError)) throw error;
			return this.invalidOp(error.message);
		}
	}

	/** The narration heard in a sequence, as the transcript panel shows it. */
	async cutTranscript(request: unknown) {
		const parsed = cutTranscriptRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const project = this.editor.project.getActiveOrNull();
		if (!project) return this.noProject();
		const { sequenceId } = parsed.data;
		const sequence = sequenceId
			? this.editor.sequences.getSequences().find(({ id }) => id === sequenceId)
			: this.editor.sequences.getActiveSequenceOrNull();
		if (!sequence)
			return this.invalidOp(
				sequenceId ? `Unknown sequence ${sequenceId}.` : "No active sequence.",
			);
		const spellings = await useCaptionsStore.getState().loadSpellings();
		const { paragraphs } = sequenceTranscript({ project, sequence, spellings });
		return {
			ok: true as const,
			sequenceId: sequence.id,
			revision: this.getRevision(),
			paragraphs: paragraphs.map(({ section, sentences }) => ({
				...(section && { section }),
				sentences: sentences.map(summarizeSentence),
			})),
			...(!hasTranscriptWords({ project, sequence }) && {
				hint:
					projectFormat({ project }) === "horizontal"
						? "No transcript words yet. Transcribe the recordings, then run captions_add."
						: "No transcript words yet. Transcribe the recordings, then run captions_add on this sequence.",
			}),
		};
	}

	/** The passage the creator selected in the transcript panel, read now. */
	async transcriptSelection(request: unknown) {
		const parsed = transcriptSelectionRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const project = this.editor.project.getActiveOrNull();
		if (!project) return this.noProject();
		const revision = this.getRevision();
		const selection = useTranscriptStore.getState().selection;
		const sequence =
			selection &&
			this.editor.sequences
				.getSequences()
				.find(({ id }) => id === selection.sequenceId);
		if (!selection || !sequence)
			return {
				ok: true as const,
				revision,
				selection: null,
				hint: "Nothing is selected. Ask the creator to select sentences in Splice's Transcript panel, or read cut_transcript.",
			};
		const spellings = await useCaptionsStore.getState().loadSpellings();
		const sentences = selectedSentences({
			sentences: sequenceTranscript({ project, sequence, spellings }).sentences,
			...selection,
		});
		if (!sentences)
			return {
				ok: true as const,
				revision,
				selection: null,
				hint: "An edit changed the passage the creator selected. Ask them to select it again.",
			};
		return {
			ok: true as const,
			revision,
			selection: summarizeSelection({ sequence, sentences }),
			...(sequence.id !== this.editor.sequences.getActiveSequenceOrNull()?.id && {
				hint: "The selection is on a sequence the creator is not viewing now.",
			}),
		};
	}

	takesList(request: unknown) {
		const parsed = takesListRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const { sequenceId } = parsed.data;
		const sequence = sequenceId
			? this.editor.sequences.getSequences().find(({ id }) => id === sequenceId)
			: this.editor.sequences.getActiveSequenceOrNull();
		if (!sequence)
			return this.invalidOp(
				sequenceId ? `Unknown sequence ${sequenceId}.` : "No active sequence.",
			);
		return {
			ok: true as const,
			sequenceId: sequence.id,
			revision: this.getRevision(),
			markers: sequence.markers.flatMap((marker) =>
				marker.data
					? [
							{
								id: marker.id,
								time: mediaTimeToSeconds({ time: marker.time }),
								sectionName: marker.data.sectionName,
								bestTake: marker.data.bestTake,
								badTakes: marker.data.badTakes,
							},
						]
					: [],
			),
		};
	}

	audioSources(request: unknown) {
		const parsed = audioSourcesRequestSchema.safeParse(request ?? {});
		if (!parsed.success) return this.invalidRequest(parsed.error);
		const { sequenceId, noiseReduction } = parsed.data;
		const sequence = sequenceId
			? this.editor.sequences.getSequences().find(({ id }) => id === sequenceId)
			: this.editor.sequences.getActiveSequenceOrNull();
		if (!sequence)
			return this.invalidOp(
				sequenceId ? `Unknown sequence ${sequenceId}.` : "No active sequence.",
			);
		const projectItems = this.editor.media.getProjectItems();
		return {
			ok: true as const,
			sequenceId: sequence.id,
			revision: this.getRevision(),
			audioSources: collectAudioSources({
				tracks:
					noiseReduction === undefined
						? sequence.tracks
						: setNoiseReduction({
								tracks: sequence.tracks,
								projectItems,
								enabled: noiseReduction,
							}),
				projectItems,
			}),
		};
	}

	private addPreparedSequence({
		sequence,
		label,
	}: {
		sequence: TSequence;
		label: string;
	}) {
		this.editor.command.execute({
			command: new AddPreparedSequenceCommand({
				editor: this.editor,
				sequence,
				label,
			}),
		});
		return {
			ok: true as const,
			sequenceId: sequence.id,
			revision: this.getRevision(),
			label,
			durationSeconds: sequenceDurationSeconds(sequence),
		};
	}

	private invalidRequest(error: {
		issues: Array<{ path: PropertyKey[]; message: string }>;
	}): EditorError {
		return {
			ok: false,
			code: "INVALID_REQUEST",
			message: error.issues
				.map(
					(issue) => `${issue.path.join(".") || "request"}: ${issue.message}`,
				)
				.join("; "),
			revision: this.getRevision(),
		};
	}

	private noProject(): EditorError {
		return {
			ok: false,
			code: "NO_PROJECT",
			message: "No project is open",
			revision: this.getRevision(),
		};
	}

	private invalidOp(message: string): EditorError {
		return {
			ok: false,
			code: "INVALID_OP",
			message,
			revision: this.getRevision(),
		};
	}

	private checkWrite({
		expectedRevision,
	}: {
		expectedRevision: number;
	}): EditorError | undefined {
		const revision = this.getRevision();
		if (
			!this.editor.project.getActiveOrNull() ||
			!this.editor.sequences.getActiveSequenceOrNull()
		) {
			return {
				ok: false,
				code: "NO_PROJECT",
				message: "No project is open",
				revision,
			};
		}
		if (this.editor.timeline.isPreviewActive()) {
			// Applying now would wipe the creator's uncommitted drag.
			return {
				ok: false,
				code: "REVISION_CONFLICT",
				message:
					"The creator is in the middle of an edit. Wait a moment, re-read the sequence and plan again.",
				revision,
			};
		}
		if (expectedRevision !== revision) {
			return {
				ok: false,
				code: "REVISION_CONFLICT",
				message: `The sequence changed (revision ${revision}, expected ${expectedRevision}). Re-read it and plan again.`,
				revision,
				digest: this.getDigest(),
			};
		}
	}

	private run({ request }: { request: ApplyRequest }): ApplyResult {
		const summary: string[] = [];
		const commands = request.ops.map(
			(op, index): Command =>
				new DeferredOpCommand(() => {
					const { command, description } = this.buildCommand({ op });
					summary[index] = description;
					return command;
				}),
		);
		const batch = new AgentBatchCommand({ editor: this.editor, commands });

		try {
			this.editor.command.execute({ command: batch });
		} catch (error) {
			// BatchCommand has already undone the ops that ran before the failure.
			const revision = this.getRevision();
			if (
				error instanceof InvalidOpError ||
				error instanceof TimeSpecError ||
				error instanceof RemovalTakeError
			) {
				return {
					ok: false,
					code: "INVALID_OP",
					message: error.message,
					revision,
				};
			}
			throw error;
		}
		return {
			ok: true,
			revision: this.getRevision(),
			label: request.label,
			summary,
		};
	}

	private buildCommand({ op }: { op: EditOp }): {
		command: Command;
		description: string;
	} {
		const fps = this.editor.project.getActive().settings.fps;
		const sequence = this.editor.sequences.getActiveSequence();
		const time = (spec: Parameters<typeof resolveTimeSpec>[0]["spec"]) =>
			resolveTimeSpec({ spec, fps });

		switch (op.op) {
			case "ripple_delete": {
				const ranges = op.ranges.map((range) => {
					const start = time(range.start);
					const end = time(range.end);
					if (end <= start) {
						throw new InvalidOpError(
							`ripple_delete: range end ${formatSeconds({ time: end })} is not after start ${formatSeconds({ time: start })}`,
						);
					}
					return { start, end };
				});
				return {
					command: new RippleDeleteRangesCommand(ranges),
					description: `ripple deleted ${ranges
						.map(
							(r) =>
								`${formatSeconds({ time: r.start })}–${formatSeconds({ time: r.end })}`,
						)
						.join(", ")}`,
				};
			}
			case "razor": {
				const at = time(op.at);
				const spansAt = (clip: TimelineClip) =>
					clip.startTime < at &&
					at < addMediaTime({ a: clip.startTime, b: clip.duration });
				const clips = this.findClipRefs({
					tracks: sequence.tracks,
					clipIds: op.clipIds,
				}).filter((ref) => spansAt(ref.clip));
				if (
					clips.length === 0 ||
					(op.clipIds && clips.length !== op.clipIds.length)
				) {
					throw new InvalidOpError(
						`razor: ${op.clipIds ? "not every listed clip" : "no clip"} spans ${formatSeconds({ time: at })}`,
					);
				}
				return {
					command: new RazorClipsCommand({
						clips: clips.map(toClipRef),
						splitTime: at,
					}),
					description: `razored ${clips.length} clip(s) at ${formatSeconds({ time: at })}`,
				};
			}
			case "delete": {
				const clips = this.findClipRefs({
					tracks: sequence.tracks,
					clipIds: op.clipIds,
				});
				return {
					command: new DeleteClipsCommand({ clips: clips.map(toClipRef) }),
					description: `deleted ${clips.length} clip(s)`,
				};
			}
			case "add_marker": {
				const at = time(op.at);
				const duration = op.duration ? time(op.duration) : undefined;
				const fields = {
					time: at,
					...(op.note ? { note: op.note } : {}),
					...(duration ? { duration } : {}),
				};
				if (op.data) {
					const projectItems = this.editor.media.getProjectItems();
					const marker = { ...fields, id: generateUUID(), data: op.data };
					const best = resolveTake({ take: op.data.bestTake, projectItems });
					for (const take of op.data.badTakes) {
						resolveTake({ take, projectItems });
					}
					return {
						command: new AddMarkerCommand({
							marker,
							tracks: markBestTake({
								tracks: sequence.tracks,
								marker,
								best,
								initialTolerance: time({ frame: 1 }),
							}),
						}),
						description: `added removal marker at ${formatSeconds({ time: at })}`,
					};
				}
				return {
					command: new AddMarkerCommand({ marker: fields }),
					description: `added marker at ${formatSeconds({ time: at })}`,
				};
			}
			case "set_gain": {
				const clips = this.findClipRefs({
					tracks: sequence.tracks,
					clipIds: op.clipIds,
				});
				const updates = clips.map(({ trackId, clipId, clip }) => {
					if (!canClipHaveAudio(clip))
						throw new InvalidOpError(`set_gain: clip ${clipId} has no audio`);
					if (hasAnimatedVolume({ clip }))
						throw new InvalidOpError(
							`set_gain: clip ${clipId} has volume keyframes, which a gain would not override`,
						);
					return {
						trackId,
						clipId,
						patch: { params: { ...clip.params, volume: op.gainDb } },
					};
				});
				return {
					command: new UpdateClipsCommand({ updates }),
					description: `set ${clips.length} clip(s) to ${formatGain(op.gainDb)}`,
				};
			}
			case "set_noise_reduction": {
				const projectItems = new Map(
					this.editor.media
						.getProjectItems()
						.map((projectItem) => [projectItem.id, projectItem]),
				);
				const clips = this.findClipRefs({
					tracks: sequence.tracks,
					clipIds: op.clipIds,
				});
				const updates = clips.map(({ trackId, clipId, clip }) => {
					if (!canClipHaveAudio(clip) || !hasMediaId(clip))
						throw new InvalidOpError(
							`set_noise_reduction: clip ${clipId} has no recording audio`,
						);
					const projectItem = projectItems.get(clip.mediaId);
					if (op.enabled && !(projectItem && isDiskMedia(projectItem.file)))
						throw new InvalidOpError(
							`set_noise_reduction: clip ${clipId} plays an item stored in the browser, not under Footage, which splice can't reduce noise for`,
						);
					return {
						trackId,
						clipId,
						patch: { params: { ...clip.params, noiseReduction: op.enabled } },
					};
				});
				return {
					command: new UpdateClipsCommand({ updates }),
					description: `turned noise reduction ${op.enabled ? "on" : "off"} for ${clips.length} clip(s)`,
				};
			}
			case "restore_takes":
			case "swap_take":
				return {
					command: new EditRemovalMarkerCommand({
						editor: this.editor,
						edit: op,
					}),
					description:
						op.op === "restore_takes"
							? `restored stored takes at marker ${op.markerId}`
							: `swapped take ${op.takeIndex + 1} at marker ${op.markerId}`,
				};
		}
	}

	/** Every clip, or only the listed ones, with its track. Throws on unknown ids. */
	private findClipRefs({
		tracks,
		clipIds,
	}: {
		tracks: SequenceTracks;
		clipIds?: string[];
	}): Array<ClipRef & { clip: TimelineClip }> {
		const refs: Array<ClipRef & { clip: TimelineClip }> = [];
		const found = new Set<string>();
		for (const track of allTracks({ tracks })) {
			for (const clip of track.clips) {
				if (clipIds && !clipIds.includes(clip.id)) continue;
				refs.push({ trackId: track.id, clipId: clip.id, clip });
				found.add(clip.id);
			}
		}
		const missing = (clipIds ?? []).filter((id) => !found.has(id));
		if (missing.length > 0) {
			throw new InvalidOpError(`Unknown clip id(s): ${missing.join(", ")}`);
		}
		return refs;
	}
}

/**
 * An agent batch. The creator's ripple toggle never changes it, and redo
 * restores exactly the sequences the batch produced, with the same clip ids,
 * so later batches that reference those ids still redo correctly. That is
 * sound because undo and redo are a linear stack: before a redo, the state is
 * the one the batch originally ran on.
 */
class AgentBatchCommand extends BatchCommand {
	readonly ignoresRippleToggle = true;
	private readonly editor: EditorCore;
	private sequencesAfter: TSequence[] | null = null;
	private executeResult: CommandResult | undefined;

	constructor({
		editor,
		commands,
	}: {
		editor: EditorCore;
		commands: Command[];
	}) {
		super(commands);
		this.editor = editor;
	}

	execute() {
		this.executeResult = super.execute();
		this.sequencesAfter = this.editor.sequences.getSequences();
		return this.executeResult;
	}

	redo() {
		if (!this.sequencesAfter) return this.execute();
		this.editor.sequences.setSequences({ sequences: this.sequencesAfter });
		return this.executeResult;
	}
}

/** Builds its real command when executed, against the state left by the ops before it. */
class DeferredOpCommand extends Command {
	private command: Command | null = null;

	constructor(private readonly build: () => Command) {
		super();
	}

	execute() {
		this.command = this.build();
		return this.command.execute();
	}

	undo(): void {
		this.command?.undo();
	}
}
