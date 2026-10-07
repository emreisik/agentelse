import { describe, expect, it } from "vitest";

import { allocateSlots, MAX_PILLARS, maxPerCluster } from "./allocate";
import { candidateFixture } from "./test-support";
import type { PlanCandidate } from "./types";

function cand(
  id: string,
  clusterId: string | null,
  score: number,
  kind: "PILLAR" | "SUPPORT" = "SUPPORT",
): PlanCandidate {
  return candidateFixture({ id, clusterId, score, kind, keyword: id });
}

function countBy(chosen: readonly PlanCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of chosen) {
    const key = item.clusterId ?? "_";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe("limits", () => {
  it("maxPerCluster and MAX_PILLARS follow the cap", () => {
    expect(maxPerCluster(4)).toBe(1);
    expect(maxPerCluster(6)).toBe(2);
    expect(maxPerCluster(12)).toBe(4);
    expect(maxPerCluster(1)).toBe(1);
    expect(MAX_PILLARS(7)).toBe(1);
    expect(MAX_PILLARS(8)).toBe(2);
  });
});

describe("allocateSlots", () => {
  it("allocates in proportion to the shares (60/30/10, cap 12)", () => {
    const list = [
      cand("a1", "A", 0.6),
      cand("a2", "A", 0.55),
      cand("a3", "A", 0.5),
      cand("a4", "A", 0.45),
      cand("b1", "B", 0.3),
      cand("b2", "B", 0.28),
      cand("b3", "B", 0.26),
      cand("c1", "C", 0.1),
      cand("c2", "C", 0.09),
    ];
    const result = allocateSlots(list, { capacity: 8, cap: 12, strongPillarClusterIds: ["A", "B", "C"] });
    expect(countBy(result.chosen)).toEqual({ A: 4, B: 3, C: 1 });
    expect(result.relaxed).toBe(false);
    expect(result.chosen[0]!.id).toBe("a1");
    expect(result.chosen).toHaveLength(8);
  });

  it("cap 4 with four or more clusters gives one slot per cluster", () => {
    const list = ["A", "B", "C", "D", "E"].flatMap((cluster, index) => [
      cand(`${cluster}1`, cluster, 0.5 - index * 0.05),
      cand(`${cluster}2`, cluster, 0.4 - index * 0.05),
    ]);
    const result = allocateSlots(list, { capacity: 4, cap: 4, strongPillarClusterIds: ["A", "B", "C", "D", "E"] });
    expect(result.chosen.map((c) => c.clusterId)).toEqual(["A", "B", "C", "D"]);
    expect(result.relaxed).toBe(false);
  });

  it("cap 4 with two clusters is filled by the relaxed second pass", () => {
    const list = [
      cand("a1", "A", 0.5),
      cand("a2", "A", 0.4),
      cand("a3", "A", 0.3),
      cand("b1", "B", 0.45),
      cand("b2", "B", 0.35),
      cand("b3", "B", 0.25),
    ];
    const result = allocateSlots(list, { capacity: 4, cap: 4, strongPillarClusterIds: ["A", "B"] });
    expect(result.chosen).toHaveLength(4);
    expect(countBy(result.chosen)).toEqual({ A: 2, B: 2 });
    expect(result.relaxed).toBe(true);
  });

  it("does not relax when the limit never blocked a pick", () => {
    const list = [cand("a1", "A", 0.5), cand("b1", "B", 0.4)];
    const result = allocateSlots(list, { capacity: 4, cap: 4, strongPillarClusterIds: ["A", "B"] });
    expect(result.chosen).toHaveLength(2);
    expect(result.relaxed).toBe(false);
  });

  it("refuses a SUPPORT of a weak-pillar cluster before its PILLAR is chosen", () => {
    const list = [
      cand("support", "W", 0.5),
      cand("pillar", "W", 0.2, "PILLAR"),
      cand("other", "X", 0.1),
    ];
    const one = allocateSlots(list, { capacity: 1, cap: 6, strongPillarClusterIds: [] });
    expect(one.chosen.map((c) => c.id)).toEqual(["pillar"]);
    // PILLAR seçildikten sonra SUPPORT artık beklemez; yalnız yer kalmamıştır.
    expect(one.skipped).toContainEqual({ candidateId: "support", reason: "CAPACITY" });

    const two = allocateSlots(list, { capacity: 2, cap: 6, strongPillarClusterIds: [] });
    expect(two.chosen.map((c) => c.id)).toEqual(["pillar", "support"]);
  });

  it("keeps a SUPPORT waiting when other picks fill the capacity first", () => {
    const list = [
      cand("support", "W", 0.5),
      cand("pillar", "W", 0.01, "PILLAR"),
      cand("other", "X", 0.3),
    ];
    const result = allocateSlots(list, { capacity: 1, cap: 6, strongPillarClusterIds: [] });
    expect(result.chosen.map((c) => c.id)).toEqual(["other"]);
    expect(result.skipped).toContainEqual({ candidateId: "support", reason: "NEEDS_PILLAR" });
  });

  it("lets a SUPPORT of a strong cluster go first", () => {
    const list = [cand("support", "S", 0.5), cand("pillar", "W", 0.2, "PILLAR")];
    const result = allocateSlots(list, { capacity: 1, cap: 6, strongPillarClusterIds: ["S"] });
    expect(result.chosen.map((c) => c.id)).toEqual(["support"]);
  });

  it("does not wait for a PILLAR that was never offered", () => {
    const result = allocateSlots([cand("support", "W", 0.5)], { capacity: 1, cap: 6, strongPillarClusterIds: [] });
    expect(result.chosen.map((c) => c.id)).toEqual(["support"]);
  });

  it("limits the PILLAR count (1 below cap 8, 2 from cap 8)", () => {
    const list = [cand("p1", "A", 0.5, "PILLAR"), cand("p2", "B", 0.4, "PILLAR")];
    const six = allocateSlots(list, { capacity: 2, cap: 6, strongPillarClusterIds: [] });
    expect(six.chosen.map((c) => c.id)).toEqual(["p1"]);
    expect(six.skipped).toEqual([{ candidateId: "p2", reason: "PILLAR_LIMIT" }]);
    const eight = allocateSlots(list, { capacity: 2, cap: 8, strongPillarClusterIds: [] });
    expect(eight.chosen.map((c) => c.id)).toEqual(["p1", "p2"]);
  });

  it("reports the cluster limit as a skip reason", () => {
    const list = [cand("a1", "A", 0.5), cand("a2", "A", 0.4), cand("b1", "B", 0.3)];
    const result = allocateSlots(list, { capacity: 2, cap: 4, strongPillarClusterIds: ["A", "B"] });
    expect(result.chosen.map((c) => c.id)).toEqual(["a1", "b1"]);
    expect(result.skipped).toEqual([{ candidateId: "a2", reason: "CLUSTER_LIMIT" }]);
  });

  it("shares one bucket between all clusterless candidates", () => {
    const list = [
      cand("x1", null, 0.5),
      cand("x2", null, 0.45),
      cand("x3", null, 0.4),
      cand("a1", "A", 0.1),
    ];
    const two = allocateSlots(list, { capacity: 2, cap: 4, strongPillarClusterIds: ["A"] });
    expect(two.chosen.map((c) => c.id)).toEqual(["x1", "a1"]);
    expect(two.relaxed).toBe(false);
    const three = allocateSlots(list, { capacity: 3, cap: 4, strongPillarClusterIds: ["A"] });
    expect(three.chosen.map((c) => c.id)).toEqual(["x1", "a1", "x2"]);
    expect(three.relaxed).toBe(true);
  });

  it("returns nothing for capacity 0 and no filler for few candidates", () => {
    const list = [cand("a1", "A", 0.5), cand("b1", "B", 0.4)];
    expect(allocateSlots(list, { capacity: 0, cap: 4, strongPillarClusterIds: [] })).toEqual({
      chosen: [],
      skipped: [],
      relaxed: false,
    });
    expect(allocateSlots(list, { capacity: -3, cap: 4, strongPillarClusterIds: [] }).chosen).toEqual([]);
    expect(allocateSlots([], { capacity: 5, cap: 4, strongPillarClusterIds: [] }).chosen).toEqual([]);
    const result = allocateSlots(list, { capacity: 6, cap: 12, strongPillarClusterIds: ["A", "B"] });
    expect(result.chosen).toHaveLength(2);
  });

  it("breaks ties by id regardless of input order", () => {
    const list = [cand("c", "C", 0.2), cand("a", "A", 0.2), cand("b", "B", 0.2)];
    const strong = ["A", "B", "C"];
    const forward = allocateSlots(list, { capacity: 3, cap: 12, strongPillarClusterIds: strong });
    const reversed = allocateSlots([...list].reverse(), { capacity: 3, cap: 12, strongPillarClusterIds: strong });
    expect(forward.chosen.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(reversed.chosen.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const list = Object.freeze([cand("a1", "A", 0.5), cand("a2", "A", 0.4)]) as readonly PlanCandidate[];
    expect(() =>
      allocateSlots(list, { capacity: 2, cap: 4, strongPillarClusterIds: Object.freeze(["A"]) }),
    ).not.toThrow();
  });

  it("property: never more than the capacity, never a duplicate, within the limits", () => {
    const list = [
      ...["A", "B", "C"].flatMap((cluster, index) =>
        [1, 2, 3, 4, 5].map((n) => cand(`${cluster}${n}`, cluster, 0.5 - index * 0.1 - n * 0.02)),
      ),
      cand("P1", "A", 0.3, "PILLAR"),
      cand("P2", "B", 0.25, "PILLAR"),
      cand("x1", null, 0.2),
    ];
    for (let capacity = 0; capacity <= 14; capacity += 1) {
      for (const cap of [1, 4, 8, 12]) {
        const result = allocateSlots(list, { capacity, cap, strongPillarClusterIds: ["C"] });
        expect(result.chosen.length).toBeLessThanOrEqual(capacity);
        expect(new Set(result.chosen.map((c) => c.id)).size).toBe(result.chosen.length);
        expect(result.chosen.filter((c) => c.kind === "PILLAR").length).toBeLessThanOrEqual(MAX_PILLARS(cap));
        const perBucket = countBy(result.chosen);
        for (const count of Object.values(perBucket)) {
          expect(count).toBeLessThanOrEqual(maxPerCluster(cap) + 1);
        }
      }
    }
  });
});
