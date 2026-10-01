import { describe, expect, it } from "vitest";
import type { NextStep } from "@/lib/journey";
import { IMAGE_PIECE_COST_USD } from "./cost";
import {
  MAX_VARIANT_ALTERNATIVES,
  VARIANT_COST_USD,
  VARIANT_COUNT,
  VARIANT_QUALITY,
  excludeVariantPieces,
  parseAlternatives,
  remainingVariantSlots,
  variantCostLabel,
} from "./variants";

describe("constants", () => {
  it("holds the single numbers", () => {
    expect(VARIANT_COUNT).toBe(3);
    expect(VARIANT_QUALITY).toBe("medium");
    expect(MAX_VARIANT_ALTERNATIVES).toBe(5);
  });
  it("derives the cost from cost.ts", () => {
    expect(VARIANT_COST_USD.post).toBe(Math.round(VARIANT_COUNT * IMAGE_PIECE_COST_USD.post * 100) / 100);
    expect(VARIANT_COST_USD.post).toBe(0.24);
    expect(VARIANT_COST_USD.story).toBe(0.32);
  });
  it("labels by format", () => {
    expect(variantCostLabel("POST")).toBe("$0.24");
    expect(variantCostLabel(null)).toBe("$0.24");
    expect(variantCostLabel("STORY")).toBe("$0.32");
    expect(variantCostLabel("REEL")).toBe("$0.32");
  });
  it("counts remaining slots", () => {
    expect(remainingVariantSlots(0)).toBe(5);
    expect(remainingVariantSlots(3)).toBe(2);
    expect(remainingVariantSlots(9)).toBe(0);
  });
});

describe("parseAlternatives", () => {
  it("is tolerant", () => {
    expect(parseAlternatives(null)).toEqual([]);
    expect(parseAlternatives({ alternatives: "x" })).toEqual([]);
    expect(
      parseAlternatives({
        alternatives: [{ assetId: "a", label: "L", assetWidth: 10, assetHeight: 20 }, null, { assetId: 3 }, { assetId: "b", assetWidth: "x" }],
      }),
    ).toEqual([{ assetId: "a", label: "L", assetWidth: 10, assetHeight: 20 }, { assetId: "b" }]);
  });
});

describe("excludeVariantPieces", () => {
  const approve = (ids: string[]): NextStep => ({
    key: "approve",
    tone: "next",
    label: `Approve ${ids.length}`,
    title: `${ids.length} pieces are ready. Approve them in one go.`,
    action: { kind: "approve_plan", planIds: ["p"], creativeIds: ids, count: ids.length },
  });
  const review: NextStep = {
    key: "review",
    tone: "next",
    label: "Review",
    title: "r",
    action: { kind: "review_queue", creativeId: "c1", count: 1 },
  };
  it("removes ids and lowers the count", () => {
    const [step] = excludeVariantPieces([approve(["a", "b", "c", "d"])], new Set(["d"]));
    expect(step!.action).toMatchObject({ creativeIds: ["a", "b", "c"], count: 3 });
    expect(step!.label).toBe("Approve 3");
  });
  it("drops a step left with fewer than 2 and keeps others", () => {
    const out = excludeVariantPieces([approve(["a", "b", "c"]), review], new Set(["b", "c"]));
    expect(out).toEqual([review]);
  });
  it("leaves untouched steps identical", () => {
    const s = approve(["a", "b"]);
    expect(excludeVariantPieces([s], new Set(["zzz"]))[0]).toBe(s);
  });
});
