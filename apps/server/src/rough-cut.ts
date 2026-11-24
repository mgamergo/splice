import type { RoughCutSources } from "@splice/bridge";
import {
	type ItemRange,
	type RoughCutCall,
	type RoughCutTightening,
	roughCutCallSchema,
} from "@splice/bridge/ops";
import type { PauseDetector } from "./pauses";

type Failure = Extract<RoughCutSources, { ok: false }>;

/**
 * Turns the agent's `rough_cut` request into the explicit plan the tab
 * applies: `pauses: "auto"` becomes detect_pauses ranges and
 * `removeFillerWords` becomes filler cuts, for every recording heard on the
 * source sequence. A plan pass also returns those ranges as `tightening`, and
 * an apply pass that sends them back cuts them instead of resolving again.
 * Anything the schema rejects goes to the tab unchanged, so the creator sees
 * one kind of validation error.
 */
export async function resolveRoughCutRequest({
	params,
	listSources,
	pauseRanges,
	fillerCuts,
}: {
	params: unknown;
	listSources: (params: { sequenceId?: string }) => Promise<RoughCutSources>;
	pauseRanges: PauseDetector["pauseRanges"];
	fillerCuts: PauseDetector["fillerCuts"];
}): Promise<
	{ plan: unknown; tightening?: RoughCutTightening } | { result: Failure }
> {
	const parsed = roughCutCallSchema.safeParse(params);
	if (!parsed.success) return { plan: params };
	const { pauses, pauseDetection, removeFillerWords, tightening, ...plan } =
		parsed.data;
	const resolved =
		tightening ??
		(await resolveTightening({
			pauses,
			pauseDetection,
			removeFillerWords,
			plan,
			listSources,
			pauseRanges,
			fillerCuts,
		}));
	if ("result" in resolved) return resolved;
	return {
		plan: { ...plan, ...resolved },
		...(plan.plan && { tightening: resolved }),
	};
}

async function resolveTightening({
	pauses,
	pauseDetection,
	removeFillerWords,
	plan: { sequenceId, expectedRevision, pausePaddingSeconds },
	listSources,
	pauseRanges,
	fillerCuts,
}: Pick<RoughCutCall, "pauses" | "pauseDetection" | "removeFillerWords"> & {
	plan: Pick<
		RoughCutCall,
		"sequenceId" | "expectedRevision" | "pausePaddingSeconds"
	>;
	listSources: (params: { sequenceId?: string }) => Promise<RoughCutSources>;
	pauseRanges: PauseDetector["pauseRanges"];
	fillerCuts: PauseDetector["fillerCuts"];
}): Promise<RoughCutTightening | { result: Failure }> {
	if (pauses !== "auto" && !removeFillerWords)
		return { pauses, fillerWords: [] };

	const sources = await listSources({ sequenceId });
	if (!sources.ok) return { result: sources };
	const failure = (message: string): { result: Failure } => ({
		result: {
			ok: false,
			code: "INVALID_OP",
			message,
			revision: expectedRevision,
		},
	});

	const detected: ItemRange[] = [];
	const fillerWords: ItemRange[] = [];
	for (const item of sources.items) {
		if (!item.path)
			return failure(
				`“${item.name}” isn't a file under Footage, so Splice can't find its pauses or filler words. Pass pauses explicitly (or []) and set removeFillerWords to false.`,
			);
		const path = item.path;
		const range = ({ start, end }: { start: number; end: number }) => ({
			projectItemId: item.id,
			sourceIn: start,
			sourceOut: end,
		});
		if (pauses === "auto")
			detected.push(
				...(await pauseRanges({ path, ...pauseDetection })).map(range),
			);
		if (removeFillerWords) {
			const cuts = await fillerCuts({
				path,
				noiseDb: pauseDetection?.noiseDb,
				paddingSeconds: pausePaddingSeconds,
			});
			if (!cuts)
				return failure(
					`Transcribe ${path} before removing filler words: Splice finds them in the transcript's word timings.`,
				);
			fillerWords.push(...cuts.map(range));
		}
	}
	return { pauses: pauses === "auto" ? detected : pauses, fillerWords };
}
