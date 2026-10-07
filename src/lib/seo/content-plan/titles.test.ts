import { describe, expect, it } from "vitest";

import { candidateFixture } from "./test-support";
import {
  basicAngle,
  basicDescription,
  basicTitle,
  cleanWording,
  hasInventedDigits,
  TITLE_MAX,
} from "./titles";

const CANDIDATE = candidateFixture({
  id: "SUPPORT:c-strong:aftercare implants tips",
  keyword: "implants aftercare tips 2026",
  queries: ["aftercare for implants"],
});
const OTHER = candidateFixture({
  id: "PILLAR:c-weak:teeth whitening",
  kind: "PILLAR",
  keyword: "teeth whitening at home",
  queries: [],
});

describe("hasInventedDigits", () => {
  it("allows digits that appear in the sources", () => {
    expect(hasInventedDigits("Implants aftercare in 2026", ["implants aftercare tips 2026"])).toBe(false);
    expect(hasInventedDigits("No digits here", [])).toBe(false);
  });

  it("rejects digits that are not in the sources", () => {
    expect(hasInventedDigits("7 implants aftercare tips", ["implants aftercare tips 2026"])).toBe(true);
    expect(hasInventedDigits("Save 30% today", ["teeth whitening"])).toBe(true);
    expect(hasInventedDigits("Top 10 tips", ["tips 100"])).toBe(true);
  });
});

describe("basicTitle", () => {
  it("upper-cases the first letter", () => {
    expect(basicTitle("teeth whitening at home")).toBe("Teeth whitening at home");
    expect(basicTitle("  extra   spaces  ")).toBe("Extra spaces");
  });

  it("uses the project language for the first letter", () => {
    expect(basicTitle("istanbul diş hekimi", "tr")).toBe("İstanbul diş hekimi");
    expect(basicTitle("istanbul dental", "en")).toBe("Istanbul dental");
    expect(basicTitle("istanbul dental", "not a locale!!")).toBe("Istanbul dental");
    expect(basicTitle("istanbul dental", null)).toBe("Istanbul dental");
  });

  it("never exceeds 90 characters", () => {
    const long = basicTitle("word ".repeat(60));
    expect(Array.from(long).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(long.endsWith(" ")).toBe(false);
    expect(Array.from(basicTitle("x".repeat(200))).length).toBe(TITLE_MAX);
  });

  it("handles an empty keyword", () => {
    expect(basicTitle("")).toBe("");
  });
});

describe("basicAngle and basicDescription", () => {
  it("returns fixed English for English or unknown languages", () => {
    for (const language of [undefined, null, "en", "en-GB", "EN"]) {
      expect(basicAngle({ kind: "PILLAR" }, language)).toBe(
        "The main guide on this topic: cover it end to end and link out to the details.",
      );
      expect(basicAngle({ kind: "SUPPORT" }, language)).toBe(
        "Answer this one question fully, then link to the main page on the topic.",
      );
      expect(basicDescription("teeth whitening", language)).toBe("Everything to know about teeth whitening.");
    }
  });

  it("is empty for other languages", () => {
    expect(basicAngle({ kind: "SUPPORT" }, "tr")).toBe("");
    expect(basicDescription("diş beyazlatma", "tr")).toBe("");
    expect(basicDescription("x", "de-DE")).toBe("");
  });

  it("clips a very long description", () => {
    expect(Array.from(basicDescription("w".repeat(500))).length).toBeLessThanOrEqual(200);
  });
});

describe("cleanWording", () => {
  it("keeps a valid title and its angle and description", () => {
    const result = cleanWording(
      {
        items: [
          {
            id: CANDIDATE.id,
            title: "Implants aftercare tips for 2026",
            angle: "A week-by-week routine from the clinic.",
            description: "What to do after the surgery.",
          },
        ],
      },
      [CANDIDATE, OTHER],
    );
    expect(result.get(CANDIDATE.id)).toEqual({
      title: "Implants aftercare tips for 2026",
      angle: "A week-by-week routine from the clinic.",
      description: "What to do after the surgery.",
    });
    expect(result.has(OTHER.id)).toBe(false);
  });

  it("accepts a bare array too", () => {
    const result = cleanWording(
      [{ id: OTHER.id, title: "Whitening your teeth at home", angle: "", description: "" }],
      [OTHER],
    );
    expect(result.get(OTHER.id)?.title).toBe("Whitening your teeth at home");
  });

  it("drops a title with invented digits", () => {
    const result = cleanWording(
      { items: [{ id: OTHER.id, title: "7 ways to whiten teeth at home", angle: "x", description: "y" }] },
      [OTHER],
    );
    expect(result.size).toBe(0);
  });

  it("drops a title without any keyword token", () => {
    const result = cleanWording(
      { items: [{ id: OTHER.id, title: "A completely unrelated headline", angle: "x", description: "y" }] },
      [OTHER],
    );
    expect(result.size).toBe(0);
  });

  it("blanks an angle or description with invented digits instead of dropping the item", () => {
    const result = cleanWording(
      {
        items: [
          { id: OTHER.id, title: "Teeth whitening at home, simply", angle: "Reach 99% whiter teeth", description: "Done in 3 days" },
        ],
      },
      [OTHER],
    );
    expect(result.get(OTHER.id)).toEqual({ title: "Teeth whitening at home, simply", angle: "", description: "" });
  });

  it("drops unknown ids and duplicate ids (the first one wins)", () => {
    const result = cleanWording(
      {
        items: [
          { id: "nope", title: "Teeth whitening at home" },
          { id: OTHER.id, title: "Teeth whitening at home, first" },
          { id: OTHER.id, title: "Teeth whitening at home, second" },
        ],
      },
      [OTHER],
    );
    expect(result.size).toBe(1);
    expect(result.get(OTHER.id)?.title).toBe("Teeth whitening at home, first");
  });

  it("drops instruction-shaped and empty titles and caps the length", () => {
    const long = `Teeth whitening at home ${"very ".repeat(60)}`;
    const result = cleanWording(
      {
        items: [
          { id: OTHER.id, title: long, angle: 5, description: null },
          { id: CANDIDATE.id, title: "   " },
        ],
      },
      [OTHER, CANDIDATE],
    );
    expect(result.has(CANDIDATE.id)).toBe(false);
    expect(Array.from(result.get(OTHER.id)!.title).length).toBeLessThanOrEqual(TITLE_MAX);
    expect(result.get(OTHER.id)).toMatchObject({ angle: "", description: "" });
  });

  it("never throws on garbage", () => {
    for (const raw of [null, undefined, 3, "x", {}, { items: "x" }, { items: [null, 4, "s", []] }, [[]]]) {
      expect(() => cleanWording(raw, [OTHER])).not.toThrow();
      expect(cleanWording(raw, [OTHER]).size).toBe(0);
    }
  });
});
