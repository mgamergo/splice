import { z } from "zod";

export const FPS = 24;
export const WIDTH = 768;
export const HEIGHT = 432;
export const duration = 72;
export const seconds = z.number().min(0).max(duration);
export const attribution = {
  title: "Interview with Jimmy Wales at Wikimania 2025 Nairobi",
  creators: "DelwarHossain and Rocky",
  source:
    "https://commons.wikimedia.org/wiki/File:Interview_with_Jimmy_Wales_at_Wikimania_2025_Nairobi.webm",
  license: "https://creativecommons.org/licenses/by/4.0/",
};
const cueId = z.number().int().positive();
export const cueList = z
  .array(
    z.object({
      id: cueId,
      start: seconds,
      end: seconds,
      text: z.string().min(1),
    }),
  )
  .min(1);
export type Cue = z.infer<typeof cueList>[number];

const caption = z.string().trim().min(1).max(48);
const shared = { cue: cueId, title: caption };
export const draftList = z.tuple([
  z.object({ ...shared, kind: z.literal("focus") }),
  z.object({ ...shared, kind: z.literal("label") }),
  z.object({
    ...shared,
    kind: z.literal("flow"),
    steps: z.tuple([caption.max(22), caption.max(22), caption.max(22)]),
  }),
]);
export type Draft = z.infer<typeof draftList>[number];

export const placement = z.object({
  cue: cueId,
  start: seconds,
  length: z.number().min(1).max(8),
  enabled: z.boolean(),
});
export type Placement = z.infer<typeof placement>;
export const frameCut = z
  .number()
  .int()
  .min(0)
  .max(duration - 8);
export const editSchema = z
  .object({
    trim: frameCut,
    visuals: z.array(placement).max(3),
  })
  .superRefine(({ trim, visuals }, ctx) => {
    const seen = new Set<number>();
    visuals.forEach((visual, index) => {
      if (
        seen.has(visual.cue) ||
        visual.start + visual.length > duration ||
        (visual.enabled && visual.start < trim)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["visuals", index],
          message: "Visual is outside the kept section or has a duplicate cue.",
        });
      }
      seen.add(visual.cue);
    });
  });
export type Edit = z.infer<typeof editSchema>;
export type Visual = Draft & Placement;
export const sampleSchema = z.object({
  cues: cueList,
  drafts: draftList,
  planner: z.string().min(1),
});
export type Sample = z.infer<typeof sampleSchema>;

export function initialPlacements(
  { cues, drafts }: Sample,
  trim: number,
): Placement[] {
  return drafts.flatMap(({ cue, kind }) => {
    const moment = cues.find((item) => item.id === cue);
    if (!moment || moment.start < trim || moment.start > duration - 1)
      return [];
    return [
      {
        cue,
        start: moment.start,
        length: Math.min(kind === "flow" ? 8 : 5, duration - moment.start),
        enabled: true,
      },
    ];
  });
}

export function resolveVisuals(
  drafts: Draft[],
  placements: Placement[],
): Visual[] {
  return placements
    .flatMap((item) => {
      const draft = drafts.find((candidate) => candidate.cue === item.cue);
      return draft ? [{ ...draft, ...item }] : [];
    })
    .sort((first, second) => first.start - second.start);
}

export function graphicsOverlap(visuals: Visual[]) {
  const graphics = visuals.filter(
    ({ kind, enabled }) => enabled && kind !== "focus",
  );
  return graphics.some((visual, index) =>
    graphics
      .slice(index + 1)
      .some(
        (next) =>
          visual.start < next.start + next.length &&
          next.start < visual.start + visual.length,
      ),
  );
}

export function applyTrim(placements: Placement[], trim: number): Placement[] {
  return placements.filter((item) => item.start >= trim);
}
