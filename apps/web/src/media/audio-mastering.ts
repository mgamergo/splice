import { MAX_TRUE_PEAK_DBTP } from "@splice/bridge/ops";

const MASTER_LIMITER_KNEE_DB = 0;
const MASTER_LIMITER_RATIO = 20;
const MASTER_LIMITER_ATTACK_SECONDS = 0.001;
const MASTER_LIMITER_RELEASE_SECONDS = 0.12;

/**
 * Playback's master chain: `input` carries the playback volume and the final
 * mix's gain, then a limiter holds peaks near the mix's ceiling. Export
 * applies the same gain and a look-ahead true-peak ceiling instead
 * (`applyMixGain`), which a live chain can't.
 */
export function createAudioMasteringChain({
	audioContext,
	destination,
}: {
	audioContext: AudioContext | OfflineAudioContext;
	destination: AudioNode;
}): {
	input: GainNode;
	limiter: DynamicsCompressorNode;
} {
	const input = audioContext.createGain();
	const limiter = audioContext.createDynamicsCompressor();

	limiter.threshold.value = MAX_TRUE_PEAK_DBTP;
	limiter.knee.value = MASTER_LIMITER_KNEE_DB;
	limiter.ratio.value = MASTER_LIMITER_RATIO;
	limiter.attack.value = MASTER_LIMITER_ATTACK_SECONDS;
	limiter.release.value = MASTER_LIMITER_RELEASE_SECONDS;

	input.connect(limiter);
	limiter.connect(destination);

	return { input, limiter };
}
