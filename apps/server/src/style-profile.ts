import {
	BASE_STYLE,
	framingKind,
	framingPreferencesSchema,
	reconcileFramingSchema,
	revertFramingPreferenceSchema,
	setStyleDefaultsSchema,
	styleDefaultsSchema,
} from "@splice/bridge/style";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { invalidParams } from "./transcription";

function profileFile<T>({
	path,
	schema,
	initial,
}: {
	path: string;
	schema: z.ZodType<T>;
	initial: T;
}) {
	let writing: Promise<unknown> = Promise.resolve();
	async function read(): Promise<T> {
		const text = await readFile(path, "utf8").catch((error: unknown) => {
			if (
				typeof error === "object" &&
				error &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return null;
			throw error;
		});
		if (text === null) return initial;
		try {
			return schema.parse(JSON.parse(text));
		} catch {
			throw new Error(`Invalid profile file: ${path}`);
		}
	}
	return {
		read,
		update(change: (current: T) => T) {
			const run = writing.then(async () => {
				const current = await read();
				const next = change(current);
				if (next === current) return current;
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					await Bun.write(temporary, JSON.stringify(next, null, 2));
					await rename(temporary, path);
				} finally {
					await rm(temporary, { force: true });
				}
				return next;
			});
			writing = run.catch(() => {});
			return run;
		},
	};
}

const framingFileSchema = z.strictObject({
	version: z.literal(1),
	preferences: framingPreferencesSchema,
});

export function createStyleProfile({ root }: { root: string }) {
	const defaults = profileFile({
		path: join(root, "Profile", "style-defaults.json"),
		schema: styleDefaultsSchema,
		initial: BASE_STYLE,
	});
	const framing = profileFile({
		path: join(root, "Profile", "framing-preferences.json"),
		schema: framingFileSchema,
		initial: { version: 1, preferences: [] },
	});
	return {
		defaults: defaults.read,
		async setDefaults(params: unknown) {
			const patch = setStyleDefaultsSchema.safeParse(params);
			if (!patch.success) throw invalidParams(patch.error.message);
			return defaults.update((current) => {
				if (current.revision !== patch.data.expectedStyleRevision)
					throw invalidParams(
						"Style defaults changed. Read the current style revision first.",
					);
				const old = current.values;
				const { fontFamily, ...caption } = patch.data.caption ?? {};
				const next = {
					card: { ...old.card, ...patch.data.card },
					highlight: { ...old.highlight, ...patch.data.highlight },
					zoom: { ...old.zoom, ...patch.data.zoom },
					caption: { ...old.caption, ...caption },
					explainer: { ...old.explainer, ...patch.data.explainer },
					raw: { ...old.raw, ...patch.data.raw },
				};
				if (fontFamily === null) delete next.caption.fontFamily;
				else if (fontFamily !== undefined) next.caption.fontFamily = fontFamily;
				if (JSON.stringify(old) === JSON.stringify(next)) return current;
				const parsed = styleDefaultsSchema.safeParse({
					...current,
					revision: current.revision + 1,
					values: next,
				});
				if (!parsed.success) throw invalidParams(parsed.error.message);
				return parsed.data;
			});
		},
		async listFraming() {
			return (await framing.read()).preferences;
		},
		async reconcileFraming(params: unknown) {
			const parsed = reconcileFramingSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { projectId, groups } = parsed.data;
			const byKind = new Map(groups.map((group) => [group.kind, group]));
			if (
				byKind.size !== groups.length ||
				groups.some(({ kind, evidence }) => {
					const property = kind.startsWith("zoom") ? "zoom" : "card";
					return (
						new Set(evidence.map(({ graphicId }) => graphicId)).size !==
							evidence.length ||
						evidence.some(
							({ before, after }) =>
								framingKind({ property, before, after }) !== kind,
						)
					);
				})
			)
				throw invalidParams(
					"Framing requires similar corrections to distinct graphics.",
				);
			return (
				await framing.update((current) => {
					const preferences = current.preferences.flatMap((entry) => {
						if (entry.reverted || entry.projectId !== projectId) return [entry];
						const group = byKind.get(entry.kind);
						return group ? [{ ...entry, evidence: group.evidence }] : [];
					});
					for (const group of groups) {
						const property = group.kind.startsWith("zoom") ? "zoom" : "card";
						const ids = new Set(group.evidence.map(({ graphicId }) => graphicId));
						if (
							preferences.some(
								(entry) =>
									entry.kind.startsWith(property) &&
									(!entry.reverted ||
										(entry.projectId === projectId &&
											entry.evidence.some(({ graphicId }) =>
												ids.has(graphicId),
											))),
							)
						)
							continue;
						preferences.push({
							...group,
							projectId,
							id: randomUUID(),
							reverted: false,
						});
					}
					return JSON.stringify(preferences) === JSON.stringify(current.preferences)
						? current
						: { ...current, preferences };
				})
			).preferences;
		},
		async revertFraming(params: unknown) {
			const parsed = revertFramingPreferenceSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			return (
				await framing.update((current) => {
					if (!current.preferences.some(({ id }) => id === parsed.data.id))
						throw invalidParams("Unknown framing preference.");
					return {
						...current,
						preferences: current.preferences.map((entry) =>
							entry.id === parsed.data.id
								? { ...entry, reverted: true }
								: entry,
						),
					};
				})
			).preferences;
		},
	};
}
