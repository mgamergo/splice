import { describe, expect, test } from "bun:test";
import type { ProjectCaptions } from "@splice/bridge/delivery";
import { audioClip, videoClip } from "@/agent/__tests__/fixtures";
import { buildEmptyTrack } from "@/timeline/placement";
import {
	buildCaptionCues,
	changedWords,
	cuesToSrt,
	formatSrtTime,
	MAX_LINE_CHARS,
	planCorrection,
	wrapCueText,
} from "@/captions/cues";
import type { SequenceTracks } from "@/timeline";
import { buildDefaultSequence } from "@/timeline/sequences";

// eslint-disable-next-line opencut/prefer-object-params -- terse test data
const word = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});

/** Words spoken one after another from `start`, each 0.3 s with 0.05 s gaps. */
// eslint-disable-next-line opencut/prefer-object-params -- terse test data
function speak(start: number, text: string) {
	return text.split(" ").map((part, index) =>
		word(start + index * 0.35, start + index * 0.35 + 0.3, part),
	);
}

function tracksWith(clips: SequenceTracks["main"]["clips"]): SequenceTracks {
	const tracks = buildDefaultSequence({ name: "S", isMain: true }).tracks;
	return { ...tracks, main: { ...tracks.main, clips } };
}

// eslint-disable-next-line opencut/prefer-object-params -- terse test data
function captionsOf(
	words: Array<ReturnType<typeof word>>,
	rest: Partial<ProjectCaptions> = {},
): ProjectCaptions {
	return {
		sources: [{ projectItemId: "rec", words }],
		cueEdits: [],
		replacements: [],
		...rest,
	};
}

const whole = tracksWith([videoClip({ id: "a", start: 0, duration: 120 })]);
const cueTexts = (cues: Array<{ text: string }>) => cues.map(({ text }) => text);

describe("buildCaptionCues", () => {
	test("breaks at sentence ends and pauses, and times cues to the words", () => {
		const words = [
			...speak(1, "Open the settings."),
			...speak(2.1, "Then pick a theme"),
			// A 1.5 s pause ends the phrase without punctuation.
			...speak(4.9, "and save it"),
		];
		const cues = buildCaptionCues({
			tracks: whole,
			captions: captionsOf(words),
			sequenceEnd: 120,
		});
		expect(cueTexts(cues)).toEqual([
			"Open the settings.",
			"Then pick a theme",
			"and save it",
		]);
		expect(cues[0].start).toBe(1);
		// Ends a hold after its last word, unless the next cue starts first.
		expect(cues[0].end).toBeCloseTo(2.1, 5);
		expect(cues[1].end).toBeCloseTo(3.45 + 0.25, 5);
		expect(cues.map(({ index }) => index)).toEqual([1, 2, 3]);
		expect(cues[0].id).toBe("rec:0-2");
	});

	test("splits a long phrase at a clause or connective, within two lines and six seconds", () => {
		const text =
			"We are going to build a small dashboard today, and we will connect it to the database because the numbers need to be live for the team";
		const cues = buildCaptionCues({
			tracks: whole,
			captions: captionsOf(speak(0, text)),
			sequenceEnd: 120,
		});
		expect(cueTexts(cues).join(" ")).toBe(text);
		for (const cue of cues) {
			expect(cue.text.length).toBeLessThanOrEqual(2 * MAX_LINE_CHARS);
			expect(cue.end - cue.start).toBeLessThanOrEqual(6.25);
		}
		expect(cues[0].text).toEndWith("today,");
		expect(cues.some(({ text }) => text.startsWith("because"))).toBe(true);
	});

	test("follows the cut: cut words drop out, later words move with their clip, kept fillers stay", () => {
		const words = [
			...speak(0, "So um this is"),
			...speak(10, "a bad take."),
			...speak(20, "the good take."),
		];
		// Keep 0–2 s and 20–22 s of the recording: the bad take is cut.
		const tracks = tracksWith([
			videoClip({ id: "a", start: 0, duration: 2 }),
			videoClip({ id: "b", start: 2, duration: 2, trimStart: 20 }),
		]);
		const cues = buildCaptionCues({
			tracks,
			captions: captionsOf(words),
			sequenceEnd: 4,
		});
		expect(cueTexts(cues)).toEqual(["So um this is", "the good take."]);
		expect(cues[1].start).toBeCloseTo(2, 5);
		expect(cues.at(-1)?.end).toBeLessThanOrEqual(4);
	});

	test("captions the narration heard in a picture-only repair, not the muted picture", () => {
		const narration = { ...audioClip({ id: "voice", start: 0, duration: 5 }), mediaId: "rec" };
		const picture = {
			...videoClip({ id: "pic", start: 0, duration: 5, trimStart: 30 }),
			isSourceAudioEnabled: false,
		};
		const tracks = tracksWith([picture]);
		tracks.audio = [
			{
				...buildEmptyTrack({ id: "voice-track", type: "audio", name: "Voice" }),
				clips: [narration],
			},
		];
		const cues = buildCaptionCues({
			tracks,
			captions: captionsOf([...speak(1, "Click save."), ...speak(31, "Wrong take.")]),
			sequenceEnd: 5,
		});
		expect(cueTexts(cues)).toEqual(["Click save."]);
	});

	test("a cue edit replaces that cue's words and follows them through later edits", () => {
		const words = [...speak(1, "I use next js."), ...speak(5, "I like next js.")];
		const captions = captionsOf(words, {
			cueEdits: [
				{
					words: [0, 1, 2, 3].map((index) => ({ projectItemId: "rec", index })),
					text: "I use Next.js.",
				},
			],
		});
		const moved = tracksWith([videoClip({ id: "a", start: 10, duration: 120 })]);
		const cues = buildCaptionCues({ tracks: moved, captions, sequenceEnd: 130 });
		expect(cueTexts(cues)).toEqual(["I use Next.js.", "I like next js."]);
		expect(cues[0]).toMatchObject({
			start: 11,
			correctedBy: "cue",
			originalText: "I use next js.",
		});
	});

	test("an empty cue edit hides the cue from the SRT but keeps it listed", () => {
		const words = [...speak(1, "Keep this."), ...speak(3, "Drop this.")];
		const cues = buildCaptionCues({
			tracks: whole,
			captions: captionsOf(words, {
				cueEdits: [
					{
						words: [2, 3].map((index) => ({ projectItemId: "rec", index })),
						text: "",
					},
				],
			}),
			sequenceEnd: 120,
		});
		expect(cueTexts(cues)).toEqual(["Keep this.", ""]);
		expect(cuesToSrt(cues)).toBe("1\n00:00:01,000 --> 00:00:02,000\nKeep this.\n");
	});

	test("project corrections apply wherever the words are heard, keeping punctuation, and win over spellings", () => {
		const words = [
			...speak(1, "I use next js,"),
			...speak(2.4, "and kubernetes."),
			...speak(6, "Next JS rocks."),
		];
		const cues = buildCaptionCues({
			tracks: whole,
			captions: captionsOf(words, {
				replacements: [{ from: "next js", to: "Next.js" }],
			}),
			spellings: [
				{ from: "kubernetes", to: "Kubernetes" },
				{ from: "next js", to: "NextJS" },
			],
			sequenceEnd: 120,
		});
		expect(cueTexts(cues)).toEqual([
			"I use Next.js, and Kubernetes.",
			"Next.js rocks.",
		]);
		expect(cues[0].correctedBy).toBe("project");
		expect(cues[1].originalText).toBe("Next JS rocks.");
	});

	test("a project correction can re-correct a spelling's words", () => {
		const cues = buildCaptionCues({
			tracks: whole,
			captions: captionsOf(speak(1, "Deploy to versel."), {
				replacements: [{ from: "Vercel", to: "Vercel's cloud" }],
			}),
			spellings: [{ from: "versel", to: "Vercel" }],
			sequenceEnd: 120,
		});
		expect(cueTexts(cues)).toEqual(["Deploy to Vercel's cloud."]);
	});

	test("no words, no cues", () => {
		expect(
			buildCaptionCues({ tracks: whole, captions: undefined, sequenceEnd: 120 }),
		).toEqual([]);
	});
});

describe("SRT", () => {
	test("numbers cues, writes millisecond times and never overlaps", () => {
		expect(formatSrtTime(3_723_004.4)).toBe("01:02:03,004");
		const srt = cuesToSrt([
			{ id: "a", index: 1, start: 0.0004, end: 1.2, text: "One.", words: [] },
			{ id: "b", index: 2, start: 1.1996, end: 2.5, text: "Two.", words: [] },
		]);
		expect(srt).toBe(
			"1\n00:00:00,000 --> 00:00:01,200\nOne.\n\n2\n00:00:01,200 --> 00:00:02,500\nTwo.\n",
		);
	});

	test("wraps a cue into two balanced lines of at most 42 characters", () => {
		const wrapped = wrapCueText(
			"Open the settings panel, then choose the dark theme for the editor",
		);
		const lines = wrapped.split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(42);
		expect(lines[0]).toBe("Open the settings panel,");
		expect(wrapCueText("Short one.")).toBe("Short one.");
	});
});

describe("corrections", () => {
	test("changedWords finds just the words that changed", () => {
		expect(
			changedWords({ before: "I use next js daily.", after: "I use Next.js daily." }),
		).toEqual({ from: "next js", to: "Next.js" });
		expect(changedWords({ before: "Hello world.", after: "Hello World!" })).toEqual({
			from: "world.",
			to: "World!",
		});
		expect(changedWords({ before: "Use git.", after: "Use Git." })).toEqual({
			from: "git",
			to: "Git",
		});
		// Only added words: nothing to replace elsewhere.
		expect(changedWords({ before: "Use git.", after: "Use git. Now." })).toBeNull();
		expect(changedWords({ before: "Same.", after: "Same." })).toBeNull();
	});

	test("a cue correction replaces an overlapping one, and typing the transcript back removes it", () => {
		const words = speak(1, "I use next js.");
		const captions = captionsOf(words);
		const [cue] = buildCaptionCues({ tracks: whole, captions, sequenceEnd: 120 });
		const first = planCorrection({ cue, text: "I use Next.js.", scope: "cue", captions });
		if (first.scope !== "cue") throw new Error("expected a cue correction");
		expect(first.captions.cueEdits).toEqual([{ words: cue.words, text: "I use Next.js." }]);

		const [edited] = buildCaptionCues({
			tracks: whole,
			captions: first.captions,
			sequenceEnd: 120,
		});
		const second = planCorrection({
			cue: edited,
			text: "I use NextJS.",
			scope: "cue",
			captions: first.captions,
		});
		if (second.scope !== "cue") throw new Error("expected a cue correction");
		expect(second.captions.cueEdits.map(({ text }) => text)).toEqual(["I use NextJS."]);

		const restored = planCorrection({
			cue: edited,
			text: "I use next js.",
			scope: "cue",
			captions: first.captions,
		});
		if (restored.scope !== "cue") throw new Error("expected a cue correction");
		expect(restored.captions.cueEdits).toEqual([]);
	});

	test("project and spelling corrections need a changed word", () => {
		const captions = captionsOf(speak(1, "Use git."));
		const [cue] = buildCaptionCues({ tracks: whole, captions, sequenceEnd: 120 });
		const project = planCorrection({ cue, text: "Use Git.", scope: "project", captions });
		expect(project).toMatchObject({
			scope: "project",
			replacement: { from: "git", to: "Git" },
			captions: { replacements: [{ from: "git", to: "Git" }] },
		});
		expect(
			planCorrection({ cue, text: "Use Git.", scope: "spelling", captions }),
		).toEqual({ scope: "spelling", replacement: { from: "git", to: "Git" } });
		expect(() =>
			planCorrection({ cue, text: "Use git. Now.", scope: "project", captions }),
		).toThrow("Change at least one word");
	});
});
