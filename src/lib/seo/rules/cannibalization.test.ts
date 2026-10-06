import { describe, expect, it } from "vitest";

import type { RuleSnapshot, WeeklyPairStat } from "@/lib/seo/opportunity-types";

import { SO4 } from "./cannibalization";
import {
  draftInvariantErrors,
  FIXTURE_PAIR_WEEKS,
  page,
  pair,
  query,
  snapshotFixture,
  weeklyPair,
} from "./test-support";

// q1 (Q = 1000), konum 5 → beklenen 0,05. clicks yüksekken CTR dalı kapalıdır
// (beklenen 0,05 × 800 = 40; 0,7 × 40 = 28).
function build(input: {
  second?: number;
  secondPath?: string;
  clicks?: number;
  weekly?: WeeklyPairStat[];
  overrides?: Partial<RuleSnapshot>;
}): RuleSnapshot {
  const second = input.second ?? 300;
  const clicks = input.clicks ?? 40;
  return snapshotFixture({
    queries: [
      query("q1", "kitchen remodel ideas", {
        impressions: 1000,
        clicks,
        position: 5,
      }),
    ],
    pages: [
      page("p1", "/kitchen-remodel", { impressions: 500, position: 5 }),
      page("p2", input.secondPath ?? "/remodel-ideas", {
        impressions: second,
        position: 5,
      }),
    ],
    pairs: [
      pair("q1", "p1", { impressions: 500, clicks: clicks / 2, position: 5 }),
      pair("q1", "p2", {
        impressions: second,
        clicks: clicks / 2,
        position: 5,
      }),
    ],
    weeklyPairs: input.weekly ?? [],
    ...input.overrides,
  });
}

// Haftalık önde gelen sayfa sırası (8 hafta).
function weeklyLeaders(leaders: readonly string[]): WeeklyPairStat[] {
  return leaders.flatMap((leader, i) => {
    const week = FIXTURE_PAIR_WEEKS[i]!;
    const other = leader === "p1" ? "p2" : "p1";
    return [
      weeklyPair(week, "q1", leader, { impressions: 60, position: 5 }),
      weeklyPair(week, "q1", other, { impressions: 40, position: 6 }),
    ];
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO4.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO4 cannibalization", () => {
  it("fires on a CTR gap when two pages share the query", () => {
    const snapshot = build({ clicks: 10 });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("query:q1");
    expect(draft.keyword).toBe("kitchen remodel ideas");
    expect(draft.pageId).toBe("p1");
    expect(draft.actionKind).toBe("CONSOLIDATE");
    expect(draft.evidence.pages?.map((p) => p.share)).toEqual([0.5, 0.3]);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs a second page with share ≥ 0.10", () => {
    expect(run(build({ clicks: 10, second: 99 })).drafts).toHaveLength(0);
    expect(run(build({ clicks: 10, second: 100 })).drafts).toHaveLength(1);
  });

  it("does not count the homepage", () => {
    expect(run(build({ clicks: 10, secondPath: "/" })).drafts).toHaveLength(0);
  });

  it("fires on two or more weekly switches of the leading page", () => {
    const one = weeklyLeaders(["p1", "p1", "p1", "p1", "p2", "p2", "p2", "p2"]);
    expect(run(build({ weekly: one })).drafts).toHaveLength(0);
    const two = weeklyLeaders(["p1", "p1", "p2", "p2", "p1", "p1", "p1", "p1"]);
    const draft = run(build({ weekly: two })).drafts[0]!;
    expect(draft.evidence.metrics.switches).toBe(2);
    // Tıklama beklenenin üstünde: etki yok.
    expect(draft.impact).toBeNull();
  });

  it("skips weeks with fewer than 5 impressions", () => {
    const weekly = weeklyLeaders([
      "p1",
      "p1",
      "p2",
      "p2",
      "p1",
      "p1",
      "p1",
      "p1",
    ]).map((row) =>
      row.weekStart === FIXTURE_PAIR_WEEKS[2] ||
      row.weekStart === FIXTURE_PAIR_WEEKS[3]
        ? { ...row, impressions: 2, positionWeighted: 10 }
        : row,
    );
    expect(run(build({ weekly })).drafts).toHaveLength(0);
  });

  it("ignores switches with fewer than 4 pair weeks", () => {
    const weekly = weeklyLeaders([
      "p1",
      "p2",
      "p1",
      "p2",
      "p1",
      "p2",
      "p1",
      "p2",
    ]);
    const snapshot = build({
      weekly,
      overrides: { pairWeeks: FIXTURE_PAIR_WEEKS.slice(0, 3) },
    });
    expect(run(snapshot).drafts).toHaveLength(0);
    expect(run(build({ weekly })).drafts).toHaveLength(1);
  });

  it("is SIGNIFICANT with Q ≥ 500 and ≥ 3 switches", () => {
    const three = weeklyLeaders([
      "p1",
      "p2",
      "p1",
      "p2",
      "p2",
      "p2",
      "p2",
      "p2",
    ]);
    expect(run(build({ weekly: three })).drafts[0]!.confidence).toBe(
      "SIGNIFICANT",
    );
    const two = weeklyLeaders(["p1", "p2", "p1", "p1", "p1", "p1", "p1", "p1"]);
    expect(run(build({ weekly: two })).drafts[0]!.confidence).toBe(
      "DIRECTIONAL",
    );
  });

  it("ignores brand queries and Q under 50", () => {
    const brand = build({ clicks: 10 });
    brand.queries[0]!.isBrand = true;
    expect(run(brand).drafts).toHaveLength(0);
    const small = build({ clicks: 1 });
    small.queries[0]!.impressions = 49;
    expect(run(small).drafts).toHaveLength(0);
  });

  it("reports queries beyond the cap of 10 in seen", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `remodel topic ${i}`, { impressions: 1000 + i }),
      ),
      pages: [page("p1", "/a"), page("p2", "/b")],
      pairs: ids.flatMap((i) => [
        pair(`q${i}`, "p1", { impressions: 500, position: 5 }),
        pair(`q${i}`, "p2", { impressions: 400, position: 5 }),
      ]),
    });
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
    expect(result.drafts[0]!.subject).toBe("query:q11");
  });
});
