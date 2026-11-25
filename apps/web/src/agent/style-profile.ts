import {
	BASE_STYLE,
	FRAMING_THRESHOLD,
	framingKind,
	framingPreferencesSchema,
	styleDefaultsSchema,
	type FramingGroup,
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

export function framingEvidence(sequences: TSequence[]): FramingGroup[] {
	const groups = new Map<
		FramingGroup["kind"],
		FramingGroup["evidence"]
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
						evidence: group.slice(-FRAMING_THRESHOLD),
					},
				],
	);
}

/** Send qualifying groups together, including an empty set after undo. */
export function watchFramingCorrections({
	editor,
	send = (params: { projectId: string; groups: FramingGroup[] }) =>
		callSplice({ method: "framing.reconcile", params }),
}: {
	editor: EditorCore;
	send?: (params: { projectId: string; groups: FramingGroup[] }) => Promise<unknown>;
}) {
	let last: { key: string } | undefined;
	let pending = Promise.resolve();
	return editor.command.subscribeRevision(() => {
		const project = editor.project.getActiveOrNull();
		if (!project) return;
		const params = {
			projectId: project.metadata.id,
			groups: framingEvidence(editor.sequences.getSequences()),
		};
		const snapshot = { key: JSON.stringify(params) };
		if (last?.key === snapshot.key) return;
		last = snapshot;
		pending = pending
			.then(async () => {
				await send(params);
			})
			.catch(() => {
				if (last === snapshot) last = undefined;
			});
	});
}
