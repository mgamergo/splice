import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_STYLE } from "@splice/bridge/style";
import { createStyleProfile } from "../style-profile";

test("persists patches and serializes concurrent updates against the defaults revision", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-style-"));
	try {
		const profile = createStyleProfile({ root });
		expect(await profile.defaults()).toEqual(BASE_STYLE);
		const results = await Promise.allSettled([
			profile.setDefaults({ expectedStyleRevision: 1, card: { fontSize: 4 } }),
			profile.setDefaults({
				expectedStyleRevision: 1,
				zoom: { easing: "linear" },
			}),
		]);
		expect(results.map(({ status }) => status)).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(await createStyleProfile({ root }).defaults()).toMatchObject({
			revision: 2,
			values: { card: { fontSize: 4 }, zoom: { easing: "bezier" } },
		});
		expect(
			await profile.setDefaults({
				expectedStyleRevision: 2,
				card: { fontSize: 4 },
			}),
		).toMatchObject({ revision: 2 });
		expect(
			await Bun.file(join(root, "Profile", "style-defaults.json")).exists(),
		).toBe(true);
		await expect(
			profile.setDefaults({
				expectedStyleRevision: 2,
				zoom: { minScale: 3 },
			}),
		).rejects.toThrow("Minimum zoom");
		expect((await profile.defaults()).revision).toBe(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("requires distinct similar corrections, and reverted evidence cannot relearn a preference", async () => {
	const root = await mkdtemp(join(tmpdir(), "splice-framing-"));
	try {
		const profile = createStyleProfile({ root });
		const evidence = [1, 2, 3].map((id) => ({
			key: `zoom:${id}`,
			graphicId: String(id),
			sequenceId: "seq",
			before: 2.5,
			after: 2,
		}));
		const proposal = { kind: "zoom-wider", projectId: "project", evidence };
		await expect(
			profile.recordFraming({ ...proposal, evidence: evidence.slice(0, 1) }),
		).rejects.toThrow();
		await expect(
			profile.recordFraming({
				...proposal,
				evidence: [evidence[0], evidence[0], evidence[1]],
			}),
		).rejects.toThrow();
		expect(await profile.listFraming()).toEqual([]);
		const [preference] = await profile.recordFraming(proposal);
		expect(preference).toMatchObject({ ...proposal, reverted: false });
		await profile.revertFraming({ id: preference.id });
		expect(await profile.recordFraming(proposal)).toEqual([
			{ ...preference, reverted: true },
		]);
		expect(await createStyleProfile({ root }).listFraming()).toEqual([
			{ ...preference, reverted: true },
		]);
		expect(
			await Bun.file(join(root, "Profile", "style-defaults.json")).exists(),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
