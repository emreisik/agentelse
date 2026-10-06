import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { percentile } from "./helpers";
import { SO1 } from "./striking-distance";
import {
  crawlPage,
  draftInvariantErrors,
  page,
  pair,
  query,
  siteCurve,
  snapshotFixture,
} from "./test-support";

// Tek sorgu/tek sayfa: Q = 1000, çift gösterimi `impressions`.
function single(input: {
  position?: number;
  impressions?: number;
  clicks?: number;
  Q?: number;
  overrides?: Partial<RuleSnapshot>;
}): RuleSnapshot {
  const position = input.position ?? 8;
  const impressions = input.impressions ?? 1000;
  const clicks = input.clicks ?? 5;
  return snapshotFixture({
    queries: [
      query("q1", "best running shoes", {
        impressions: input.Q ?? 1000,
        clicks,
        position,
      }),
    ],
    pages: [page("p1", "/running-shoes", { impressions, clicks, position })],
    pairs: [pair("q1", "p1", { impressions, clicks, position })],
    ...input.overrides,
  });
}

function drafts(snapshot: RuleSnapshot) {
  const result = SO1.evaluate(snapshot);
  if (!result.evaluable) throw new Error("not evaluable");
  return result;
}

describe("SO1 striking distance", () => {
  it("fires for a page just below the top results", () => {
    const snapshot = single({});
    const result = drafts(snapshot);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0]!;
    expect(draft.subject).toBe("page:p1");
    expect(draft.kind).toBe("OPPORTUNITY");
    expect(draft.actionKind).toBe("CONTENT_REFRESH");
    expect(draft.effort).toBe("M");
    expect(draft.signalWorthy).toBe(false);
    expect(draft.periodKey).toBe("W:2026-09-27");
    expect(draft.evidence.queries?.[0]?.expectedCtr).toBe(0.05);
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("keeps the position window [4, 20]", () => {
    expect(drafts(single({ position: 3.99 })).drafts).toHaveLength(0);
    expect(drafts(single({ position: 4 })).drafts).toHaveLength(1);
    expect(drafts(single({ position: 20 })).drafts).toHaveLength(1);
    expect(drafts(single({ position: 20.01 })).drafts).toHaveLength(0);
  });

  it("needs the pair impressions to reach max(100, p75)", () => {
    // Doldurucu çiftler 2. sırada (kural dışı) ama yüzdeliğe girer: p75 = 800.
    const fillers = [300, 300, 300, 800, 800, 800, 800, 800];
    const build = (impressions: number) =>
      single({
        impressions,
        Q: impressions,
        clicks: 0,
        overrides: {},
      });
    const withFillers = (impressions: number) => {
      const base = build(impressions);
      return {
        ...base,
        queries: [
          ...base.queries,
          ...fillers.map((v, i) =>
            query(`f${i}`, `filler topic ${i}`, {
              impressions: v,
              position: 2,
            }),
          ),
        ],
        pairs: [
          ...base.pairs,
          ...fillers.map((v, i) =>
            pair(`f${i}`, "p2", { impressions: v, position: 2 }),
          ),
        ],
      };
    };
    const p75 = percentile([...fillers, 800], 75);
    expect(p75).toBe(800);
    expect(drafts(withFillers(p75 - 1)).drafts).toHaveLength(0);
    expect(drafts(withFillers(p75)).drafts).toHaveLength(1);
    // Taban 100.
    expect(
      drafts(single({ impressions: 99, Q: 99, clicks: 0, position: 4 })).drafts,
    ).toHaveLength(0);
  });

  it("needs a share of at least 0.8 of Q", () => {
    expect(drafts(single({ impressions: 790, Q: 1000 })).drafts).toHaveLength(
      0,
    );
    expect(drafts(single({ impressions: 800, Q: 1000 })).drafts).toHaveLength(
      1,
    );
  });

  it("needs a monthly gain of at least 5 clicks", () => {
    // Konum 8 → hedef 5 (CTR 0,05); 200 gösterim → beklenen 10 tıklama.
    const at = (gain: number) => 10 - (gain * 28) / 30;
    expect(
      drafts(single({ impressions: 200, Q: 200, clicks: at(4.9) })).drafts,
    ).toHaveLength(0);
    expect(
      drafts(single({ impressions: 200, Q: 200, clicks: at(5) })).drafts,
    ).toHaveLength(1);
  });

  it("ignores brand queries", () => {
    const snapshot = single({});
    snapshot.queries[0]!.isBrand = true;
    expect(drafts(snapshot).drafts).toHaveLength(0);
  });

  it("suggests internal links for a weakly linked page", () => {
    const snapshot = single({
      overrides: {
        crawl: {
          complete: true,
          pages: [crawlPage("p1", "/running-shoes", { inlinks: 2 })],
          links: [],
        },
      },
    });
    const draft = drafts(snapshot).drafts[0]!;
    expect(draft.actionKind).toBe("INTERNAL_LINKS");
    expect(draft.effort).toBe("S");
  });

  it("is SIGNIFICANT only with ≥ 500 impressions and a site curve", () => {
    const prior = drafts(single({})).drafts[0]!;
    expect(prior.confidence).toBe("DIRECTIONAL");
    const site = (impressions: number) =>
      single({
        impressions,
        Q: impressions,
        clicks: 0,
        overrides: {
          curves: { nonBrand: siteCurve(), brand: siteCurve("brand") },
        },
      });
    expect(drafts(site(500)).drafts[0]!.confidence).toBe("SIGNIFICANT");
    expect(drafts(site(499)).drafts[0]!.confidence).toBe("DIRECTIONAL");
  });

  it("reports every qualifying page in seen, beyond the cap of 10", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const snapshot = snapshotFixture({
      queries: ids.map((i) =>
        query(`q${i}`, `topic number ${i} guide`, {
          impressions: 1000,
          position: 8,
        }),
      ),
      pages: ids.map((i) => page(`p${i}`, `/page-${i}`, { impressions: 1000 })),
      // Eşit gösterim (p75 = 1000); tıklama arttıkça kazanç azalır.
      pairs: ids.map((i) =>
        pair(`q${i}`, `p${i}`, { impressions: 1000, clicks: i, position: 8 }),
      ),
    });
    const result = drafts(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
    expect(result.drafts[0]!.subject).toBe("page:p0");
    expect(result.seen).toContain("page:p11");
    for (const draft of result.drafts) {
      expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
    }
  });
});
