import { buildSequenceDigest } from "@/agent/digest";
import { type ApplyRequest, applyRequestSchema, type EditOp } from "@/agent/ops";
import { formatSeconds, resolveTimeSpec, TimeSpecError } from "@/agent/time";
import { Command } from "@/commands/base-command";
import { BatchCommand } from "@/commands/batch-command";
import { AddMarkerCommand } from "@/commands/sequence/add-marker";
import { RippleDeleteRangesCommand } from "@/commands/sequence/ripple-delete-ranges";
import { DeleteClipsCommand } from "@/commands/timeline/clip/delete-clips";
import { RazorClipsCommand } from "@/commands/timeline/clip/razor-clips";
import type { EditorCore } from "@/core";
import type { ClipRef, SequenceTracks, TimelineClip } from "@/timeline";
import { addMediaTime } from "@/wasm";

export type ApplyErrorCode = "INVALID_REQUEST" | "REVISION_CONFLICT" | "INVALID_OP" | "NO_PROJECT";

export type ApplyResult =
	| { ok: true; revision: number; label: string; summary: string[] }
	| {
			ok: false;
			code: ApplyErrorCode;
			message: string;
			revision: number;
			/** The current digest, so the agent can re-plan after a conflict. */
			digest?: string;
	  };

class InvalidOpError extends Error {}

function toClipRef({ trackId, clipId }: ClipRef): ClipRef {
	return { trackId, clipId };
}

function allTracks({ tracks }: { tracks: SequenceTracks }) {
	return [tracks.main, ...tracks.overlay, ...tracks.audio];
}

/**
 * The agent's way into the editor. Every write goes through `apply`, which
 * runs all its ops as one undo step and refuses to run against a sequence the
 * creator has changed since the agent last read it.
 */
export class EditorApi {
	constructor(private readonly editor: EditorCore) {}

	getRevision(): number {
		return this.editor.command.getRevision();
	}

	getDigest(): string {
		const project = this.editor.project.getActive();
		const sequence = this.editor.sequences.getActiveSequenceOrNull();
		if (!project || !sequence) {
			return "(no project open)";
		}
		return buildSequenceDigest({ project, sequence, revision: this.getRevision() });
	}

	apply(request: unknown): ApplyResult {
		const revision = this.getRevision();
		const parsed = applyRequestSchema.safeParse(request);
		if (!parsed.success) {
			return {
				ok: false,
				code: "INVALID_REQUEST",
				message: parsed.error.issues
					.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
					.join("; "),
				revision,
			};
		}
		if (!this.editor.project.getActive() || !this.editor.sequences.getActiveSequenceOrNull()) {
			return { ok: false, code: "NO_PROJECT", message: "No project is open", revision };
		}
		if (parsed.data.expectedRevision !== revision) {
			return {
				ok: false,
				code: "REVISION_CONFLICT",
				message: `The sequence changed (revision ${revision}, expected ${parsed.data.expectedRevision}). Re-read it and plan again.`,
				revision,
				digest: this.getDigest(),
			};
		}
		return this.run({ request: parsed.data });
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
		const batch = new AgentBatchCommand(commands);

		try {
			this.editor.command.execute({ command: batch });
		} catch (error) {
			// BatchCommand has already undone the ops that ran before the failure.
			const revision = this.getRevision();
			if (error instanceof InvalidOpError || error instanceof TimeSpecError) {
				return { ok: false, code: "INVALID_OP", message: error.message, revision };
			}
			throw error;
		}
		return { ok: true, revision: this.getRevision(), label: request.label, summary };
	}

	private buildCommand({ op }: { op: EditOp }): { command: Command; description: string } {
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
						.map((r) => `${formatSeconds({ time: r.start })}–${formatSeconds({ time: r.end })}`)
						.join(", ")}`,
				};
			}
			case "razor": {
				const at = time(op.at);
				const spansAt = (clip: TimelineClip) =>
					clip.startTime < at && at < addMediaTime({ a: clip.startTime, b: clip.duration });
				const clips = this.findClipRefs({ tracks: sequence.tracks, clipIds: op.clipIds }).filter(
					(ref) => spansAt(ref.clip),
				);
				if (clips.length === 0 || (op.clipIds && clips.length !== op.clipIds.length)) {
					throw new InvalidOpError(
						`razor: ${op.clipIds ? "not every listed clip" : "no clip"} spans ${formatSeconds({ time: at })}`,
					);
				}
				return {
					command: new RazorClipsCommand({ clips: clips.map(toClipRef), splitTime: at }),
					description: `razored ${clips.length} clip(s) at ${formatSeconds({ time: at })}`,
				};
			}
			case "delete": {
				const clips = this.findClipRefs({ tracks: sequence.tracks, clipIds: op.clipIds });
				return {
					command: new DeleteClipsCommand({ clips: clips.map(toClipRef) }),
					description: `deleted ${clips.length} clip(s)`,
				};
			}
			case "add_marker": {
				const at = time(op.at);
				const duration = op.duration ? time(op.duration) : undefined;
				return {
					command: new AddMarkerCommand({
						time: at,
						...(op.note ? { note: op.note } : {}),
						...(duration ? { duration } : {}),
					}),
					description: `added marker at ${formatSeconds({ time: at })}`,
				};
			}
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

/** The creator's ripple toggle must not change what the agent asked for. */
class AgentBatchCommand extends BatchCommand {
	readonly ignoresRippleToggle = true;
}

/**
 * Builds its real command when executed, against the state left by the ops
 * before it. Redo builds it again, because earlier ops may have created clips
 * with new ids.
 */
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

	redo() {
		return this.execute();
	}
}
