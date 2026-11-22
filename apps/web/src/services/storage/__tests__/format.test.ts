import { describe, expect, test } from "bun:test";
import { isSupportedProjectFormat, PROJECT_FORMAT_VERSION } from "../format";

describe("isSupportedProjectFormat", () => {
	test("accepts the current format", () => {
		expect(isSupportedProjectFormat({ version: PROJECT_FORMAT_VERSION })).toBe(true);
	});

	test("rejects other, missing and non-numeric versions", () => {
		for (const version of [0, 2, 31, undefined, null, "1"]) {
			expect(isSupportedProjectFormat({ version })).toBe(false);
		}
	});
});
