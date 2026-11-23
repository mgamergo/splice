import assert from "node:assert/strict";
import {
  applyTrim,
  editSchema,
  initialPlacements,
  resolveVisuals,
  sampleSchema,
} from "../src/model";

const sample = sampleSchema.parse(
  await Bun.file(new URL("../fixtures/analysis.json", import.meta.url)).json(),
);
const placements = initialPlacements(sample, 0);
assert.equal(placements.length, 3);
for (const visual of placements) {
  assert.equal(
    visual.start,
    sample.cues.find((cue) => cue.id === visual.cue)?.start,
  );
}
const trim = 20;
const kept = applyTrim(placements, trim);
assert.deepEqual(
  kept,
  placements.filter((visual) => visual.start >= trim),
);
assert.equal(editSchema.safeParse({ trim, visuals: kept }).success, true);
assert.equal(resolveVisuals(sample.drafts, kept).length, kept.length);
console.info("Visuals preserve their source anchors after a trim.");

const [first] = placements;
assert.ok(first);
assert.equal(
  editSchema.safeParse({ trim: 5, visuals: [{ ...first, start: 2 }] }).success,
  false,
);
assert.equal(
  editSchema.safeParse({ trim: 0, visuals: [first, first] }).success,
  false,
);
console.info(
  "Export validation rejects a lost anchor and duplicate placements.",
);
