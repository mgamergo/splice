import {
	BASE_STYLE,
	FRAMING_THRESHOLD,
	framingKind,
	framingPreferencesSchema,
	styleDefaultsSchema,
	type FramingEvidence,
} from "@splice/bridge/style";
import { readBridgeToken } from "@/bridge/token";
import { callSplice } from "@/bridge/splice-api";
import type { EditorCore } from "@/core";
import type { TProject } from "@/project/types";
import type { TSequence } from "@/timeline/types";

export function projectStyle(project: TProject) {
	return project.settings.styleDefaults ?? BASE_STYLE;
}

export function sequenceStyle({
	project,
	sequence,
}: {
	project: TProject;
	sequence: TSequence;
}) {
	return sequence.styleDefaults ?? projectStyle(project);
}

export function oldestStyleRevision({
	project,
	sequences,
}: {
	project: TProject;
	sequences: TSequence[];
}) {
	return sequences.reduce(
		(revision, sequence) =>
			Math.min(revision, sequenceStyle({ project, sequence }).revision),
		projectStyle(project).revision,
	);
}

export async function fetchStyleDefaults() {
	return styleDefaultsSchema.parse(
		await callSplice({ method: "style.defaults" }),
	);
}

export async function readStyleDefaults() {
	return readBridgeToken() ? fetchStyleDefaults() : BASE_STYLE;
}

export async function readFraming() {
	return framingPreferencesSchema
		.parse(await callSplice({ method: "framing.list" }).catch(() => []))
		.filter(({ reverted }) => !reverted);
}

export function framingEvidence({
	project,
	sequences,
}: {
	project: TProject;
	sequences: TSequence[];
}): FramingEvidence[] {
	const groups = new Map<
		FramingEvidence["kind"],
		FramingEvidence["evidence"]
	>();
	const seen = new Set<string>();
	for (const sequence of sequences) {
		for (const record of sequence.graphics?.records ?? []) {
			if (seen.has(record.id) || !record.framingCorrection) continue;
			seen.add(record.id);
			if (record.kind !== "zoom" && record.kind !== "card") continue;
			const { before, after } = record.framingCorrection;
			const kind = framingKind({ property: record.kind, before, after });
			if (!kind) continue;
			const group = groups.get(kind) ?? [];
			group.push({
				graphicId: record.id,
				sequenceId: sequence.id,
				key: record.key,
				before,
				after,
			});
			groups.set(kind, group);
		}
	}
	return [...groups].flatMap(([kind, group]) =>
		group.length < FRAMING_THRESHOLD
			? []
			: [
					{
						kind,
						projectId: project.metadata.id,
						evidence: group.slice(-FRAMING_THRESHOLD),
					},
				],
	);
}

/** An individual correction stays in the project. Send only qualifying groups. */
export function watchFramingCorrections(editor: EditorCore) {
	let sent = "";
	return editor.command.subscribeRevision(() => {
		const project = editor.project.getActiveOrNull();
		if (!project) return;
		const groups = framingEvidence({
			project,
			sequences: editor.sequences.getSequences(),
		});
		const key = JSON.stringify(groups);
		if (key === sent || !groups.length) return;
		sent = key;
		void Promise.all(
			groups.map((params) => callSplice({ method: "framing.record", params })),
		).catch(() => {
			if (sent === key) sent = "";
		});
	});
}
