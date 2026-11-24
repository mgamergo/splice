import { formatGain } from "@/agent/loudness";
import { formatSeconds } from "@/agent/time";
import { projectFormat } from "@/project/format";
import type { TProject } from "@/project/types";
import { getSourceSpanAtClipTime } from "@/retime";
import { canClipHaveAudio, isRetimableClip } from "@/timeline";
import { isNoiseReduced } from "@/timeline/audio-state";
import type { TimelineClip, TSequence } from "@/timeline";
import { addMediaTime, roundMediaTime } from "@/wasm";

function describeClip({ clip }: { clip: TimelineClip }): string {
	const end = addMediaTime({ a: clip.startTime, b: clip.duration });
	let text = `[${clip.id} ${clip.type} "${clip.name}" ${formatSeconds({ time: clip.startTime })}–${formatSeconds({ time: end })}`;
	if ("mediaId" in clip) {
		const sourceSpan = roundMediaTime({
			time: getSourceSpanAtClipTime({
				clipTime: clip.duration,
				retime: isRetimableClip(clip) ? clip.retime : undefined,
			}),
		});
		const sourceEnd = addMediaTime({ a: clip.trimStart, b: sourceSpan });
		text += ` (src ${formatSeconds({ time: clip.trimStart })}–${formatSeconds({ time: sourceEnd })})`;
	}
	const volume = canClipHaveAudio(clip) ? clip.params.volume : undefined;
	if (typeof volume === "number" && volume !== 0)
		text += ` gain ${formatGain(volume)}`;
	if (canClipHaveAudio(clip) && isNoiseReduced({ clip })) text += " denoised";
	if (clip.type === "text") {
		const content = String(clip.params.content ?? "").replace(/\s+/g, " ");
		text += ` ${JSON.stringify(content.length > 40 ? `${content.slice(0, 39)}…` : content)}`;
	}
	return `${text}]`;
}

/**
 * A compact, line-oriented view of the active sequence for a language model.
 * Video tracks are numbered from the main track (V1) upwards and audio tracks
 * from A1, as in Premiere.
 */
export function buildSequenceDigest({
	project,
	sequence,
	revision,
}: {
	project: TProject;
	sequence: TSequence;
	revision: number;
}): string {
	const { canvasSize, fps } = project.settings;
	const lines = [
		`project "${project.metadata.name}" ${projectFormat({ project })} ${canvasSize.width}x${canvasSize.height} @${fps.numerator / fps.denominator}fps, revision ${revision}`,
		`sequence "${sequence.name}" (${sequence.id})`,
	];
	const videoTracks = [
		sequence.tracks.main,
		...[...sequence.tracks.overlay].reverse(),
	];
	videoTracks.forEach((track, index) => {
		const clips = track.clips.map((clip) => describeClip({ clip })).join(" ");
		lines.push(
			`V${index + 1} ${track.type} (${track.id}): ${clips || "(empty)"}`,
		);
	});
	sequence.tracks.audio.forEach((track, index) => {
		const clips = track.clips.map((clip) => describeClip({ clip })).join(" ");
		lines.push(`A${index + 1} (${track.id}): ${clips || "(empty)"}`);
	});
	const markers = sequence.markers
		.map((marker) => {
			const time = formatSeconds({ time: marker.time });
			if (marker.data) {
				const { sectionName, badTakes } = marker.data;
				const count = badTakes.length;
				return `${time} removal ${JSON.stringify(sectionName)} (${count} ${count === 1 ? "take" : "takes"} stored) [${marker.id}]`;
			}
			return `${time}${marker.note ? ` ${JSON.stringify(marker.note)}` : ""}`;
		})
		.join(", ");
	lines.push(`markers: ${markers || "(none)"}`);
	return lines.join("\n");
}
