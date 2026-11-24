import {
	type Replacement,
	removeSpellingRequestSchema,
	spellingRequestSchema,
	spellingsFileSchema,
} from "@splice/bridge/delivery";
import { RPC_ERRORS } from "@splice/bridge";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BridgeError } from "./tab-bridge";
import { invalidParams } from "./transcription";

/** Reusable caption spellings the creator saved, applied in every project. */
export const SPELLINGS_PATH = ["Profile", "spellings.json"] as const;

const key = (from: string) => from.trim().toLowerCase().replace(/\s+/g, " ");

export function createSpellingStore({ root }: { root: string }) {
	const path = join(root, ...SPELLINGS_PATH);
	// Saves and removals rewrite the file one at a time.
	let writing: Promise<unknown> = Promise.resolve();

	async function read(): Promise<Replacement[]> {
		let text: string;
		try {
			text = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const parsed = spellingsFileSchema.safeParse(JSON.parse(text));
		if (!parsed.success)
			throw new BridgeError({
				code: RPC_ERRORS.INTERNAL,
				message: `${path} is not a valid spellings file. Move it aside to start a new one.`,
			});
		return parsed.data.spellings;
	}

	function update(change: (spellings: Replacement[]) => Replacement[]) {
		const run = writing.then(async () => {
			const spellings = change(await read());
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			await Bun.write(
				temporary,
				JSON.stringify({ version: 1, spellings }, null, 2),
			);
			await rename(temporary, path);
			return { spellings };
		});
		writing = run.catch(() => {});
		return run;
	}

	return {
		async list() {
			return { spellings: await read() };
		},
		/** Saves a spelling, replacing one for the same words. */
		async save(params: unknown) {
			const parsed = spellingRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			const spelling = parsed.data;
			return update((spellings) => [
				...spellings.filter(({ from }) => key(from) !== key(spelling.from)),
				spelling,
			]);
		},
		async remove(params: unknown) {
			const parsed = removeSpellingRequestSchema.safeParse(params);
			if (!parsed.success) throw invalidParams(parsed.error.message);
			return update((spellings) =>
				spellings.filter(({ from }) => key(from) !== key(parsed.data.from)),
			);
		},
	};
}
