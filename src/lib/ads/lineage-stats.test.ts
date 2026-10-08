import { describe, expect, it } from "vitest";

import {
  findTagEffects,
  findingRef,
  findingText,
  type LineageAdRow,
} from "./lineage-stats";

function row(
  adId: string,
  hook: string,
  spendMinor: number,
  results: number,
  recipe = "leads_instant_form",
): LineageAdRow {
  return { recipe, adId, tags: { hook, format: "image" }, spendMinor, results };
}

describe("findTagEffects", () => {
  it("finds a hook that brings results far cheaper, with enough evidence", () => {
    const rows = [
      row("a1", "question", 10_000, 40),
      row("a2", "question", 10_000, 38),
      row("a3", "statement", 10_000, 20),
      row("a4", "statement", 10_000, 22),
    ];
    const findings = findTagEffects(rows);
    const question = findings.find((f) => f.value === "question");
    expect(question).toMatchObject({ key: "hook", polarity: "WORKS" });
    expect(question!.ratio).toBeLessThan(0.6);
    const statement = findings.find((f) => f.value === "statement");
    expect(statement).toMatchObject({ polarity: "AVOID" });
  });

  it("ignores a difference that is within noise", () => {
    const rows = [
      row("a1", "question", 10_000, 21),
      row("a2", "question", 10_000, 19),
      row("a3", "statement", 10_000, 20),
      row("a4", "statement", 10_000, 20),
    ];
    expect(findTagEffects(rows)).toEqual([]);
  });

  it("needs at least two ads on each side", () => {
    const rows = [
      row("a1", "question", 10_000, 80),
      row("a3", "statement", 10_000, 20),
      row("a4", "statement", 10_000, 22),
    ];
    expect(findTagEffects(rows)).toEqual([]);
  });

  it("needs enough results on each side", () => {
    const rows = [
      row("a1", "question", 10_000, 6),
      row("a2", "question", 10_000, 5),
      row("a3", "statement", 10_000, 1),
      row("a4", "statement", 10_000, 1),
    ];
    expect(findTagEffects(rows)).toEqual([]);
  });

  it("never compares across recipes", () => {
    const rows = [
      row("a1", "question", 10_000, 40, "traffic"),
      row("a2", "question", 10_000, 38, "traffic"),
      row("a3", "statement", 10_000, 20, "leads_instant_form"),
      row("a4", "statement", 10_000, 22, "leads_instant_form"),
    ];
    expect(findTagEffects(rows)).toEqual([]);
  });

  it("skips a tag with only one value", () => {
    const rows = [
      row("a1", "question", 10_000, 40),
      row("a2", "question", 10_000, 38),
    ];
    expect(findTagEffects(rows)).toEqual([]);
  });
});

describe("finding texts", () => {
  const finding = {
    recipe: "leads_instant_form",
    key: "hook",
    value: "question",
    polarity: "WORKS" as const,
    ratio: 0.68,
    resultsIn: 78,
    resultsRest: 42,
    adsIn: 2,
    adsRest: 2,
    z: 3.1,
  };

  it("says what happened in plain words with the evidence", () => {
    expect(findingText(finding, "lead")).toBe(
      "Ads that open with a question cost 32% less per lead than the other hooks (78 vs 42 results, 2 and 2 ads, 95% confidence).",
    );
    expect(
      findingText({ ...finding, polarity: "AVOID", ratio: 1.4 }, "lead"),
    ).toContain("cost 40% more per lead");
  });

  it("gives one stable reference per finding", () => {
    expect(findingRef(finding)).toBe("lineage:leads_instant_form:hook:question");
  });
});
