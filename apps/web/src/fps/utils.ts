import type { FrameRate } from "opencut-wasm";
import type { ProjectItem } from "@/media/types";

type ProjectItemFpsInput = Pick<ProjectItem, "type" | "fps">;

const STANDARD_FRAME_RATES: Array<{ value: number; rate: FrameRate }> = [
	{ value: 24_000 / 1_001, rate: { numerator: 24_000, denominator: 1_001 } },
	{ value: 24, rate: { numerator: 24, denominator: 1 } },
	{ value: 25, rate: { numerator: 25, denominator: 1 } },
	{ value: 30_000 / 1_001, rate: { numerator: 30_000, denominator: 1_001 } },
	{ value: 30, rate: { numerator: 30, denominator: 1 } },
	{ value: 48, rate: { numerator: 48, denominator: 1 } },
	{ value: 50, rate: { numerator: 50, denominator: 1 } },
	{ value: 60_000 / 1_001, rate: { numerator: 60_000, denominator: 1_001 } },
	{ value: 60, rate: { numerator: 60, denominator: 1 } },
	{ value: 120, rate: { numerator: 120, denominator: 1 } },
];

const STANDARD_FRAME_RATE_TOLERANCE = 0.01;

export function frameRateToFloat(rate: FrameRate): number {
	return rate.numerator / rate.denominator;
}

export function frameRatesEqual({
	a,
	b,
}: {
	a: FrameRate;
	b: FrameRate;
}): boolean {
	return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function floatToFrameRate(fps: number): FrameRate {
	const standard = STANDARD_FRAME_RATES.find(
		(candidate) => Math.abs(fps - candidate.value) <= STANDARD_FRAME_RATE_TOLERANCE,
	);
	if (standard) return standard.rate;

	if (Number.isInteger(fps)) {
		return { numerator: fps, denominator: 1 };
	}

	const ARBITRARY_DENOMINATOR = 1_000_000;
	const scaledNumerator = Math.round(fps * ARBITRARY_DENOMINATOR);
	const divisor = gcd({
		left: scaledNumerator,
		right: ARBITRARY_DENOMINATOR,
	});
	return {
		numerator: scaledNumerator / divisor,
		denominator: ARBITRARY_DENOMINATOR / divisor,
	};
}

function gcd({ left, right }: { left: number; right: number }): number {
	let a = Math.abs(left);
	let b = Math.abs(right);
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a || 1;
}

export function getHighestImportedVideoFps({
	projectItems,
}: {
	projectItems: ProjectItemFpsInput[];
}): number | null {
	let highestFps: number | null = null;

	for (const projectItem of projectItems) {
		const fps = projectItem.fps ?? Number.NaN;
		if (projectItem.type !== "video") continue;
		if (!Number.isFinite(fps) || fps <= 0) continue;

		highestFps = highestFps === null ? fps : Math.max(highestFps, fps);
	}

	return highestFps;
}

export function getRaisedProjectFpsForImportedMedia({
	currentFps,
	importedProjectItems,
}: {
	currentFps: FrameRate;
	importedProjectItems: ProjectItemFpsInput[];
}): FrameRate | null {
	const highestImportedVideoFps = getHighestImportedVideoFps({
		projectItems: importedProjectItems,
	});

	const currentFpsFloat = frameRateToFloat(currentFps);

	if (highestImportedVideoFps === null || highestImportedVideoFps <= currentFpsFloat) {
		return null;
	}

	return floatToFrameRate(highestImportedVideoFps);
}
