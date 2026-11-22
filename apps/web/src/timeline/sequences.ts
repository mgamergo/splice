import type { TSequence } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { calculateTotalDuration } from "@/timeline";
import { MAIN_TRACK_NAME } from "@/timeline/placement/main-track";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";

export function getMainSequence({ sequences }: { sequences: TSequence[] }): TSequence | null {
	return sequences.find((sequence) => sequence.isMain) || null;
}

export function ensureMainSequence({ sequences }: { sequences: TSequence[] }): TSequence[] {
	const hasMain = sequences.some((sequence) => sequence.isMain);
	if (!hasMain) {
		const mainSequence = buildDefaultSequence({ name: "Main sequence", isMain: true });
		return [mainSequence, ...sequences];
	}
	return sequences;
}

export function buildDefaultSequence({
	name,
	isMain,
}: {
	name: string;
	isMain: boolean;
}): TSequence {
	return {
		id: generateUUID(),
		name,
		isMain,
		tracks: {
			overlay: [],
			main: {
				id: generateUUID(),
				name: MAIN_TRACK_NAME,
				type: "video",
				clips: [],
				muted: false,
				hidden: false,
			},
			audio: [],
		},
		markers: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

export function canDeleteSequence({ sequence }: { sequence: TSequence }): {
	canDelete: boolean;
	reason?: string;
} {
	if (sequence.isMain) {
		return { canDelete: false, reason: "Cannot delete main sequence" };
	}
	return { canDelete: true };
}

export function getFallbackSequenceAfterDelete({
	sequences,
	deletedSequenceId,
	currentSequenceId,
}: {
	sequences: TSequence[];
	deletedSequenceId: string;
	currentSequenceId: string | null;
}): TSequence | null {
	if (currentSequenceId !== deletedSequenceId) {
		return sequences.find((s) => s.id === currentSequenceId) || null;
	}
	return getMainSequence({ sequences });
}

export function findCurrentSequence({
	sequences,
	currentSequenceId,
}: {
	sequences: TSequence[];
	currentSequenceId: string;
}): TSequence | null {
	return (
		sequences.find((s) => s.id === currentSequenceId) ||
		getMainSequence({ sequences }) ||
		sequences[0] ||
		null
	);
}

export function getProjectDurationFromSequences({
	sequences,
}: {
	sequences: TSequence[];
}): MediaTime {
	const mainSequence = getMainSequence({ sequences }) ?? sequences[0] ?? null;
	if (!mainSequence?.tracks) {
		return ZERO_MEDIA_TIME;
	}

	return calculateTotalDuration({ tracks: mainSequence.tracks });
}

export function updateSequenceInArray({
	sequences,
	sequenceId,
	updates,
}: {
	sequences: TSequence[];
	sequenceId: string;
	updates: Partial<TSequence>;
}): TSequence[] {
	return sequences.map((sequence) =>
		sequence.id === sequenceId ? { ...sequence, ...updates } : sequence,
	);
}
