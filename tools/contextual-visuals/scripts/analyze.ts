import { z } from "zod";
import { cueList, draftList, duration, type Draft } from "../src/model";

const transcriptPath = process.argv[2];
if (!transcriptPath) {
  throw new Error("Usage: bun run analyze path/to/whisper.json");
}
const whisper = z.object({
  transcription: z.array(
    z.object({
      offsets: z.object({ from: z.number(), to: z.number() }),
      text: z.string(),
    }),
  ),
});
const startOffset = 24.36;
const input = whisper.parse(await Bun.file(transcriptPath).json());
const cues = cueList.parse(
  input.transcription
    .filter(
      ({ offsets }) =>
        offsets.from >= startOffset * 1000 &&
        offsets.to <= (startOffset + duration) * 1000 + 1,
    )
    .map(({ offsets, text }, index) => ({
      id: index + 1,
      start: Math.round(offsets.from - startOffset * 1000) / 1000,
      end: Math.round(offsets.to - startOffset * 1000) / 1000,
      text: text.trim().replaceAll("Bangalore", "Bangla"),
    })),
);

const plannerResponse = z.object({
  choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]),
});
const title = z.string().min(1).max(48);
function cueBetween(from: number, to: number) {
  return z.literal(
    cues
      .filter((cue) => cue.start >= from && cue.start < to)
      .map(({ id }) => id),
  );
}
const planSchema = z.object({
  focus: z.object({ cue: cueBetween(6, duration / 3), title }),
  label: z.object({ cue: cueBetween(duration / 3, (duration * 2) / 3), title }),
  flow: z.object({
    cue: cueBetween((duration * 2) / 3, duration - 5),
    title,
    steps: z.array(z.string().regex(/^[A-Z][A-Za-z '-]{2,21}$/)).length(3),
  }),
});
const provider = process.env.LLAMA_SERVER ?? "http://127.0.0.1:8091";
const response = await fetch(new URL("/v1/chat/completions", provider), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  signal: AbortSignal.timeout(120_000),
  body: JSON.stringify({
    temperature: 0,
    max_tokens: 384,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "visual_plan",
        schema: z.toJSONSchema(planSchema),
      },
    },
    messages: [
      {
        role: "system",
        content:
          "You edit a documentary interview. Use the supplied transcript as evidence. Return an object with focus, label and flow. Include three short steps in the flow. Use the allowed cue IDs in the schema. The focus belongs in the first third, the label in the middle, and the flow in the final third. The flow's steps may be paraphrases but each action must be supported by nearby speech. The title must cover a specific idea from the selected cue or the cue immediately after it. The focus emphasizes a strong shift or point. The label describes a concrete goal or fact and avoids generic phrases such as key advice. The flow is anchored where the speaker starts a process. Its steps are complete short verb phrases, with no cue numbers, quotations or commentary. Example for a gardening interview: Choose a seed, Plant it, Water the soil. Use only content in this interview.",
      },
      {
        role: "user",
        content: cues
          .map(({ id, text }) => `${String(id)} | ${text}`)
          .join("\n"),
      },
    ],
  }),
});
if (!response.ok)
  throw new Error(
    `Planner returned HTTP ${response.status}: ${await response.text()}`,
  );
const parsed = plannerResponse.parse(await response.json());
const plan = planSchema.parse(JSON.parse(parsed.choices[0].message.content));
const visuals = draftList.parse([
  { kind: "focus", ...plan.focus },
  { kind: "label", ...plan.label },
  { kind: "flow", ...plan.flow },
]);
checkGrounding(visuals);

await Bun.write(
  new URL("../fixtures/analysis.json", import.meta.url),
  `${JSON.stringify(
    { cues, drafts: visuals, planner: "Qwen 2.5 3B · Sample analysis" },
    null,
    2,
  )}\n`,
);
console.info(`Planned three visuals from ${cues.length} transcript cues.`);
console.info(visuals);

function checkGrounding(drafts: Draft[]) {
  const references = new Set<number>();
  for (const draft of drafts) {
    const cue = cues.find((item) => item.id === draft.cue);
    if (
      !cue ||
      references.has(draft.cue) ||
      cue.start < 6 ||
      cue.start > duration - 5
    ) {
      throw new Error(
        "Planner used an overlapping, missing, or out-of-scope cue: " +
          draft.cue,
      );
    }
    references.add(draft.cue);
  }
}
