import type { RoughCutSources } from "@splice/bridge";
import { roughCutRequestSchema, type SourceRange } from "@splice/bridge/ops";
import type { PauseDetector } from "./pauses";

type Failure = Extract<RoughCutSources, { ok: false }>;

/**
 * Turns the agent's `rough_cut` request into the explicit plan the tab
 * applies: `pauses: "auto"` becomes detect_pauses ranges and
 * `removeFillerWords` becomes filler cuts, for every recording on the
 * source sequence. Anything the schema rejects goes to the tab unchanged, so
 * the creator sees one kind of validation error.
 */
export async function resolveRoughCutRequest({
	params,
	listSources,
	detect,
	fillerCuts,
}: {
	params: unknown;
	listSources: (params: { sequenceId?: string }) => Promise<RoughCutSources>;
	detect: PauseDetector["detect"];
	fillerCuts: PauseDetector["fillerCuts"];
}): Promise<{ plan: unknown } | { result: Failure }> {
	const parsed = roughCutRequestSchema.safeParse(params);
	if (!parsed.success) return { plan: params };
	const { pauses, pauseDetection, removeFillerWords, ...plan } = parsed.data;
	if (pauses !== "auto" && !removeFillerWords)
		return { plan: { ...plan, pauses, fillerWords: [] } };

	const sources = await listSources({ sequenceId: plan.sequenceId });
	if (!sources.ok) return { result: sources };
	const failure = (message: string): { result: Failure } => ({
		result: {
			ok: false,
			code: "INVALID_OP",
			message,
			revision: plan.expectedRevision,
		},
	});

	const detected: SourceRange[] = [];
	const fillerWords: SourceRange[] = [];
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
		if (pauses === "auto") {
			const result = await detect({ path, ...pauseDetection });
			detected.push(...result.pauses.map(range));
		}
		if (removeFillerWords) {
			const cuts = await fillerCuts({
				path,
				noiseDb: pauseDetection?.noiseDb,
				paddingSeconds: plan.pausePaddingSeconds,
			});
			if (!cuts)
				return failure(
					`Transcribe ${path} before removing filler words: Splice finds them in the transcript's word timings.`,
				);
			fillerWords.push(...cuts.map(range));
		}
	}
	return {
		plan: {
			...plan,
			pauses: pauses === "auto" ? detected : pauses,
			fillerWords,
		},
	};
}
