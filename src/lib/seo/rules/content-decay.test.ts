import { describe, expect, it } from "vitest";

import type { RuleSnapshot } from "@/lib/seo/opportunity-types";

import { SO3, SO3_CTR_NOTE } from "./content-decay";
import {
  crawlPage,
  draftInvariantErrors,
  metric,
  page,
  pair,
  query,
  snapshotFixture,
  type MetricInput,
} from "./test-support";

// 15 tam ay: 2025-06 … 2026-08. Son 6: 2026-03 … 2026-08.
const MONTHS_15 = Array.from({ length: 15 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 5 + i, 1));
  return date.toISOString().slice(0, 10);
});

// Aylık tıklamalar üç ayda eşit dağıtılır; konum ve gösterim değişmez
// (neden MIXED değil DEMAND/CTR/RANKING olmasın diye ayrıca verilir).
function build(input: {
  months?: number;
  prior: number;
  recent: number;
  yearAgo?: number;
  priorMetric?: MetricInput;
  recentMetric?: MetricInput;
  overrides?: Partial<RuleSnapshot>;
}): RuleSnapshot {
  const months = MONTHS_15.slice(-(input.months ?? 6));
  const rows = months.map((month, i) => {
    const fromEnd = months.length - i;
    let clicks = 0;
    let base: MetricInput = { impressions: 2000, position: 5 };
    if (fromEnd <= 3) {
      clicks = input.recent / 3;
      base = input.recentMetric ?? base;
    } else if (fromEnd <= 6) {
      clicks = input.prior / 3;
      base = input.priorMetric ?? base;
    } else if (fromEnd >= 13) {
      clicks = (input.yearAgo ?? 0) / 3;
    }
    return { pageId: "p1", month, ...metric({ ...base, clicks }) };
  });
  return snapshotFixture({
    queries: [
      query("q1", "garden hose reviews", {
        impressions: 400,
        clicks: 10,
        position: 6,
      }),
    ],
    pages: [
      page("p1", "/garden-hoses", {
        impressions: 400,
        clicks: 10,
        position: 6,
      }),
    ],
    pairs: [pair("q1", "p1", { impressions: 400, clicks: 10, position: 6 })],
    months,
    monthlyPages: rows,
    ...input.overrides,
  });
}

function run(snapshot: RuleSnapshot) {
  const result = SO3.evaluate(snapshot);
  if (!result.evaluable) throw new Error(`not evaluable: ${result.reason}`);
  return result;
}

describe("SO3 content decay", () => {
  it("needs monthly pages and at least six months", () => {
    expect(SO3.evaluate(build({ months: 5, prior: 300, recent: 100 }))).toEqual(
      {
        evaluable: false,
        reason: "LOW_HISTORY",
      },
    );
    expect(
      SO3.evaluate(snapshotFixture({ monthlyPages: null, months: MONTHS_15 })),
    ).toEqual({ evaluable: false, reason: "LOW_HISTORY" });
    expect(
      run(build({ months: 6, prior: 300, recent: 100 })).drafts,
    ).toHaveLength(1);
  });

  it("fires on a 30% drop but not on 29.9%", () => {
    expect(run(build({ prior: 1000, recent: 701 })).drafts).toHaveLength(0);
    const snapshot = build({ prior: 1000, recent: 700 });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.subject).toBe("page:p1");
    expect(draft.kind).toBe("RISK");
    expect(draft.severity).toBe("WARN");
    expect(draft.signalWorthy).toBe(true);
    expect(draft.periodKey).toBe("M:2026-08-01");
    expect(draft.periodStart).toBe("2026-06-01");
    expect(draft.periodEnd).toBe("2026-08-31");
    expect(draft.evidence.compare).toEqual({
      from: "2026-03-01",
      to: "2026-05-31",
    });
    expect(draft.evidence.metrics).toMatchObject({
      recentClicks: 700,
      priorClicks: 1000,
      dropPercent: 30,
    });
    expect(draftInvariantErrors(snapshot, draft)).toEqual([]);
  });

  it("needs a loss of at least max(30, 10% of prior)", () => {
    expect(run(build({ prior: 60, recent: 31 })).drafts).toHaveLength(0);
    expect(run(build({ prior: 60, recent: 30 })).drafts).toHaveLength(1);
  });

  it("checks the same months last year when 15 months exist", () => {
    // Geçen yıl 300 → bugün 210: %30 düşüş, tetikler.
    const yes = run(
      build({ months: 15, prior: 300, recent: 210, yearAgo: 300 }),
    );
    expect(yes.drafts).toHaveLength(1);
    expect(yes.drafts[0]!.evidence.metrics.yearAgoClicks).toBe(300);
    // Geçen yıl da 250: mevsimsel, tetiklemez.
    expect(
      run(build({ months: 15, prior: 300, recent: 210, yearAgo: 250 })).drafts,
    ).toHaveLength(0);
    // 14 ayda geçen yıl bilinmez; yalnız P/R bakılır.
    const noYoy = run(
      build({ months: 14, prior: 300, recent: 210, yearAgo: 250 }),
    );
    expect(noYoy.drafts).toHaveLength(1);
    expect(noYoy.drafts[0]!.evidence.metrics.yearAgoClicks).toBeUndefined();
  });

  it("is SIGNIFICANT only with year-over-year data and a loss of ≥ 100", () => {
    expect(
      run(build({ months: 15, prior: 300, recent: 200, yearAgo: 300 }))
        .drafts[0]!.confidence,
    ).toBe("SIGNIFICANT");
    expect(
      run(build({ months: 15, prior: 300, recent: 201, yearAgo: 300 }))
        .drafts[0]!.confidence,
    ).toBe("DIRECTIONAL");
    expect(run(build({ prior: 300, recent: 100 })).drafts[0]!.confidence).toBe(
      "DIRECTIONAL",
    );
  });

  it("maps the cause to the action", () => {
    const ranking = run(
      build({
        prior: 300,
        recent: 150,
        priorMetric: { impressions: 2000, position: 5 },
        recentMetric: { impressions: 2000, position: 8 },
      }),
    ).drafts[0]!;
    expect(ranking.evidence.cause).toBe("RANKING");
    expect(ranking.actionKind).toBe("CONTENT_REFRESH");
    expect(ranking.ideaWorthy).toBe(true);

    const ctr = run(build({ prior: 300, recent: 150 })).drafts[0]!;
    expect(ctr.evidence.cause).toBe("CTR");
    expect(ctr.actionKind).toBe("TITLE_META");
    expect(ctr.effort).toBe("S");
    expect(ctr.evidence.notes).toEqual([SO3_CTR_NOTE]);

    const demand = run(
      build({
        prior: 300,
        recent: 150,
        priorMetric: { impressions: 2000, position: 5 },
        recentMetric: { impressions: 1000, position: 5 },
      }),
    ).drafts[0]!;
    expect(demand.evidence.cause).toBe("DEMAND");
    expect(demand.actionKind).toBe("INVESTIGATE");
    expect(demand.ideaWorthy).toBe(false);

    const index = run(
      build({
        prior: 300,
        recent: 150,
        overrides: {
          crawl: {
            complete: true,
            pages: [crawlPage("p1", "/garden-hoses", { status: 404 })],
            links: [],
          },
        },
      }),
    ).drafts[0]!;
    expect(index.evidence.cause).toBe("INDEX");
    expect(index.actionKind).toBe("TECH_FIX");
    expect(index.effort).toBe("VARIES");
  });

  it("detects cannibalization from the page's top queries", () => {
    const snapshot = build({
      prior: 300,
      recent: 150,
      overrides: {
        queries: [
          query("q1", "garden hose reviews", {
            impressions: 1000,
            clicks: 20,
            position: 6,
          }),
        ],
        pages: [
          page("p1", "/garden-hoses", {
            impressions: 100,
            clicks: 2,
            position: 9,
          }),
          page("p2", "/hose-buying-guide", {
            impressions: 800,
            clicks: 18,
            position: 4,
          }),
        ],
        pairs: [
          pair("q1", "p1", { impressions: 100, clicks: 2, position: 9 }),
          pair("q1", "p2", { impressions: 800, clicks: 18, position: 4 }),
        ],
        previousQueries: [
          {
            id: "q1",
            ...metric({ impressions: 1000, clicks: 30, position: 4 }),
          },
        ],
        previousPairs: [
          pair("q1", "p1", { impressions: 900, clicks: 28, position: 4 }),
          pair("q1", "p2", { impressions: 50, clicks: 2, position: 12 }),
        ],
      },
    });
    const draft = run(snapshot).drafts[0]!;
    expect(draft.evidence.cause).toBe("CANNIBALIZATION");
    expect(draft.actionKind).toBe("CONSOLIDATE");
  });

  it("reports pages beyond the cap of 10 in seen", () => {
    const ids = Array.from({ length: 12 }, (_, i) => i);
    const base = build({ prior: 300, recent: 150 });
    const snapshot: RuleSnapshot = {
      ...base,
      monthlyPages: ids.flatMap((i) =>
        base.monthlyPages!.map((row) => ({ ...row, pageId: `p${i}` })),
      ),
    };
    const result = run(snapshot);
    expect(result.drafts).toHaveLength(10);
    expect(result.seen).toHaveLength(12);
  });
});
