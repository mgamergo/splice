import {
	BASE_STYLE,
	framingEvidenceSchema,
	framingKind,
	framingPreferencesSchema,
	revertFramingPreferenceSchema,
	setStyleDefaultsSchema,
	styleDefaultsSchema,
	type FramingPreference,
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
		async recordFraming(params: unknown) {
			const parsed = framingEvidenceSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const { kind, projectId, evidence } = parsed.data;
			const property = kind.startsWith("zoom") ? "zoom" : "card";
			const ids = new Set(evidence.map(({ graphicId }) => graphicId));
			if (
				ids.size !== evidence.length ||
				evidence.some(
					({ before, after }) =>
						framingKind({ property, before, after }) !== kind,
				)
			)
				throw invalidParams(
					"Framing requires similar corrections to distinct graphics.",
				);
			return (
				await framing.update((current) => {
					const sameProperty = (entry: FramingPreference) =>
						entry.kind.startsWith(property);
					if (
						current.preferences.some(
							(entry) =>
								sameProperty(entry) &&
								(!entry.reverted ||
									(entry.projectId === projectId &&
										entry.evidence.some(({ graphicId }) =>
											ids.has(graphicId),
										))),
						)
					)
						return current;
					return {
						...current,
						preferences: [
							...current.preferences,
							{ ...parsed.data, id: randomUUID(), reverted: false },
						],
					};
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
