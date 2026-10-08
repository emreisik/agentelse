import { describe, expect, it } from "vitest";

import {
  ArtDirectionSchema,
  assembleScene,
  directionAvoid,
} from "./art-direction";

const direction = ArtDirectionSchema.parse({
  concept: "A quiet Sunday ritual",
  subject: "A copper pour-over kettle steaming above two ceramic cups",
  setting: "A sunlit oak counter in a small Istanbul cafe",
  composition: "Low three-quarter angle, subject in the lower right, upper left left empty",
  lighting: "Soft window light from the left, warm morning colour temperature",
  technique: "85mm lens at f/2.0, shallow depth of field, gentle film grade",
  texture: "Visible steam, ring marks on the wood, a few stray coffee grounds",
  mood: "Calm and unhurried",
  avoid: ["floating particles.", "plastic-looking steam"],
});

describe("assembleScene", () => {
  it("puts the subject first and every decision after it, each a sentence", () => {
    const scene = assembleScene(direction);
    expect(scene.startsWith("A copper pour-over kettle")).toBe(true);
    for (const label of ["Setting:", "Composition:", "Lighting:", "Technique:", "Texture and detail:", "Mood:"]) {
      expect(scene).toContain(label);
    }
    expect(scene).not.toContain("..");
  });
});

describe("directionAvoid", () => {
  it("joins the director's own list, without stray full stops", () => {
    expect(directionAvoid(direction)).toBe(
      "floating particles; plastic-looking steam",
    );
  });

  it("is nothing when there is nothing to avoid", () => {
    expect(directionAvoid({ ...direction, avoid: [] })).toBeUndefined();
  });
});

describe("ArtDirectionSchema", () => {
  it("refuses an empty decision, so a gap is a failure and not a blank", () => {
    expect(ArtDirectionSchema.safeParse({ ...direction, subject: "  " }).success).toBe(false);
  });

  it("keeps alternatives optional", () => {
    expect(ArtDirectionSchema.safeParse({ ...direction, alternatives: undefined }).success).toBe(true);
  });
});
