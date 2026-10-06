import { describe, expect, it } from "vitest";

import {
  allowedNumbersOf,
  checkSummaryNumbers,
  numberTokens,
} from "@/lib/module-flows/analytics/number-check";

import {
  DIAG_DROP,
  DIAGNOSE_STEP_ORDER,
  changeRatio,
  diagnoseSearchDrop,
} from "./diagnose";
import { DIAGNOSE_DRILLS, NO_DROP_DRILL, drillInput } from "./drill-fixtures";
import type { DiagnoseInput, DiagnoseStepKey } from "./types";

const KEYS = Object.keys(DIAGNOSE_DRILLS) as DiagnoseStepKey[];

function stepOf(input: DiagnoseInput, key: DiagnoseStepKey) {
  const step = diagnoseSearchDrop(input).steps.find((s) => s.key === key);
  if (!step) throw new Error(`missing step ${key}`);
  return step;
}

describe("changeRatio", () => {
  it("is null when the previous value is not positive", () => {
    expect(changeRatio(5, 0)).toBeNull();
    expect(changeRatio(5, -1)).toBeNull();
  });

  it("returns the relative change", () => {
    expect(changeRatio(70, 100)).toBeCloseTo(-0.3);
    expect(changeRatio(150, 100)).toBeCloseTo(0.5);
  });
});

describe("diagnoseSearchDrop drills", () => {
  it.each(KEYS)("the %s drill is the primary cause and the only one", (key) => {
    const diagnosis = diagnoseSearchDrop(DIAGNOSE_DRILLS[key]);
    expect(diagnosis.dropped).toBe(true);
    expect(diagnosis.primary).toBe(key);
    expect(diagnosis.also).toEqual([]);
    expect(diagnosis.summary).toMatch(/^Most likely cause: /);
  });

  it("does not report a drop on the healthy baseline", () => {
    const diagnosis = diagnoseSearchDrop(NO_DROP_DRILL);
    expect(diagnosis.dropped).toBe(false);
    expect(diagnosis.primary).toBeNull();
    expect(diagnosis.also).toEqual([]);
    expect(diagnosis.askUser).toEqual([]);
    expect(diagnosis.summary).toBe("Clicks did not drop in this period (−2%).");
  });

  it("names the non-brand metric in the not-dropped summary", () => {
    const diagnosis = diagnoseSearchDrop({
      ...NO_DROP_DRILL,
      metric: "nonBrandClicks",
    });
    expect(diagnosis.summary).toMatch(/^Non-brand clicks did not drop/);
  });

  it("needs enough previous clicks and a big enough change to call it a drop", () => {
    const small = diagnoseSearchDrop({
      ...DIAGNOSE_DRILLS.ranking,
      totals: {
        previous: { clicks: 20, impressions: 400, positionWeighted: 2400 },
        current: { clicks: 5, impressions: 400, positionWeighted: 2400 },
      },
    });
    expect(small.dropped).toBe(false);

    const edge = diagnoseSearchDrop({
      ...NO_DROP_DRILL,
      totals: {
        previous: { clicks: 1000, impressions: 40_000, positionWeighted: 1 },
        current: {
          clicks: 1000 * (1 + DIAG_DROP),
          impressions: 40_000,
          positionWeighted: 1,
        },
      },
    });
    expect(edge.dropped).toBe(true);
  });

  it("keeps two causes: data first, ranking in also", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.ranking,
      data: { ...DIAGNOSE_DRILLS.ranking.data, missingDays: 3 },
    };
    const diagnosis = diagnoseSearchDrop(input);
    expect(diagnosis.primary).toBe("data");
    expect(diagnosis.also).toEqual(["ranking"]);
  });

  it("says no single cause stands out when every step is no", () => {
    const diagnosis = diagnoseSearchDrop({
      ...DIAGNOSE_DRILLS.data,
      data: drillInput().data,
    });
    expect(diagnosis.dropped).toBe(true);
    expect(diagnosis.primary).toBeNull();
    expect(diagnosis.summary).toBe(
      "No single cause stands out. Check the steps below and the two Search Console screens.",
    );
  });

  it("always has the eight steps in order", () => {
    for (const input of [NO_DROP_DRILL, ...Object.values(DIAGNOSE_DRILLS)]) {
      const diagnosis = diagnoseSearchDrop(input);
      expect(diagnosis.steps).toHaveLength(8);
      expect(diagnosis.steps.map((step) => step.key)).toEqual([
        ...DIAGNOSE_STEP_ORDER,
      ]);
      for (const step of diagnosis.steps) {
        expect(step.evidence.length).toBeGreaterThan(0);
        expect(step.evidence.length).toBeLessThanOrEqual(4);
        expect(step.items.length).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe("diagnoseSearchDrop unavailable sources", () => {
  it("marks indexing and technical unknown without health data", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.ranking,
      health: { available: false, alerts: [], coverage: null },
    };
    expect(stepOf(input, "indexing").verdict).toBe("unknown");
    expect(stepOf(input, "technical").verdict).toBe("unknown");
    expect(diagnoseSearchDrop(input).primary).toBe("ranking");
  });

  it("marks the update step unknown without update history", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.update,
      updatesAvailable: false,
    };
    expect(stepOf(input, "update").verdict).toBe("unknown");
    expect(diagnoseSearchDrop(input).primary).toBeNull();
  });

  it("marks cannibalization unknown without pairs", () => {
    const input = { ...NO_DROP_DRILL, pairs: [] };
    expect(stepOf(input, "cannibalization").verdict).toBe("unknown");
  });

  it("marks demand unknown with too few impressions", () => {
    const input: DiagnoseInput = { ...NO_DROP_DRILL, queries: [] };
    expect(stepOf(input, "demand").verdict).toBe("unknown");
    expect(stepOf(input, "ranking").verdict).toBe("unknown");
    expect(stepOf(input, "ctr").verdict).toBe("unknown");
  });
});

describe("diagnoseSearchDrop steps", () => {
  it("treats a 0.7 position worsening with a CTR drop as a CTR problem", () => {
    const base = DIAGNOSE_DRILLS.ctr;
    const input: DiagnoseInput = {
      ...base,
      queries: base.queries.map((query) => ({
        ...query,
        current: {
          ...query.current,
          positionWeighted: query.current.impressions * 6.7,
        },
      })),
    };
    expect(stepOf(input, "ranking").verdict).toBe("no");
    expect(stepOf(input, "ctr").verdict).toBe("yes");
    expect(diagnoseSearchDrop(input).primary).toBe("ctr");
  });

  it("flags an indexing or crawling incident that overlaps the period", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.update,
      updates: [
        {
          name: "Indexing delays",
          kind: "INDEXING",
          startedAt: "2026-09-05T00:00:00.000Z",
          endedAt: null,
        },
      ],
    };
    const indexing = stepOf(input, "indexing");
    expect(indexing.verdict).toBe("yes");
    expect(indexing.evidence.join(" ")).toContain("Indexing delays");
    expect(stepOf(input, "update").verdict).toBe("no");
  });

  it("looks a few days back for the lead of an incident", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.update,
      updates: [
        {
          name: "Crawling issue",
          kind: "CRAWLING",
          startedAt: "2026-09-01T00:00:00.000Z",
          endedAt: "2026-09-05T00:00:00.000Z",
        },
      ],
    };
    // 7 Eylül'den 3 gün öncesi 4 Eylül: olay 5'ine kadar sürdü.
    expect(stepOf(input, "indexing").verdict).toBe("yes");
    const later: DiagnoseInput = {
      ...input,
      updates: [
        {
          name: "Crawling issue",
          kind: "CRAWLING",
          startedAt: "2026-09-01T00:00:00.000Z",
          endedAt: "2026-09-03T00:00:00.000Z",
        },
      ],
    };
    expect(stepOf(later, "indexing").verdict).toBe("no");
  });

  it("uses a serving incident as data evidence only", () => {
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.update,
      updates: [
        ...DIAGNOSE_DRILLS.update.updates,
        {
          name: "Serving outage",
          kind: "SERVING",
          startedAt: "2026-09-25T00:00:00.000Z",
          endedAt: "2026-09-26T00:00:00.000Z",
        },
      ],
    };
    const data = stepOf(input, "data");
    expect(data.verdict).toBe("no");
    expect(data.evidence.join(" ")).toContain(
      "Google reported a search serving incident: Serving outage.",
    );
    expect(diagnoseSearchDrop(input).primary).toBe("update");
  });

  it("makes stale data a data problem", () => {
    const input: DiagnoseInput = {
      ...NO_DROP_DRILL,
      data: { ...NO_DROP_DRILL.data, finalThrough: "2026-09-20" },
    };
    const data = stepOf(input, "data");
    expect(data.verdict).toBe("yes");
    expect(data.metrics.staleDays).toBe(17);
  });

  it("reads a coverage drop as an indexing problem", () => {
    const estimate = (point: number, low: number, high: number) => ({
      sampled: 100,
      indexed: Math.round(point * 100),
      crawledNotIndexed: 0,
      point,
      low,
      high,
    });
    const input: DiagnoseInput = {
      ...DIAGNOSE_DRILLS.update,
      updates: [],
      health: {
        available: true,
        alerts: [],
        coverage: {
          previous: estimate(0.9, 0.82, 0.95),
          current: estimate(0.6, 0.5, 0.69),
        },
      },
    };
    const indexing = stepOf(input, "indexing");
    expect(indexing.verdict).toBe("yes");
    expect(indexing.metrics).toMatchObject({
      coverageBeforePct: 90,
      coverageNowPct: 60,
    });
  });

  it("adds seasonal evidence when last year fell too", () => {
    const base = DIAGNOSE_DRILLS.demand;
    const seasonal: DiagnoseInput = {
      ...base,
      yearAgo: {
        previous: { clicks: 1000, impressions: 40_000, positionWeighted: 1 },
        current: { clicks: 700, impressions: 40_000, positionWeighted: 1 },
      },
    };
    const demand = stepOf(seasonal, "demand");
    expect(demand.verdict).toBe("yes");
    expect(demand.evidence).toContain(
      "The same weeks last year also fell by 30%.",
    );
    expect(stepOf(base, "demand").evidence.join(" ")).not.toContain(
      "last year",
    );
  });

  it("lists the cannibalized searches with the old and new page", () => {
    const step = stepOf(DIAGNOSE_DRILLS.cannibalization, "cannibalization");
    expect(step.verdict).toBe("yes");
    expect(step.items).toHaveLength(3);
    expect(step.items[0]).toMatchObject({ detail: "/old → /new" });
  });

  it("lists the lost pages that are not indexed", () => {
    const step = stepOf(DIAGNOSE_DRILLS.indexing, "indexing");
    expect(step.items).toHaveLength(3);
    expect(step.metrics.lostSharePct).toBe(100);
  });

  it("lists worsening pages on a ranking drop", () => {
    const step = stepOf(DIAGNOSE_DRILLS.ranking, "ranking");
    expect(step.metrics).toMatchObject({ positionBefore: 6, positionNow: 9 });
    expect(step.items.length).toBe(5);
  });
});

describe("diagnoseSearchDrop askUser", () => {
  it.each(KEYS)("lists both Search Console screens for the %s drill", (key) => {
    const diagnosis = diagnoseSearchDrop(DIAGNOSE_DRILLS[key]);
    expect(diagnosis.askUser.map((ask) => ask.screen)).toEqual([
      "Manual actions",
      "Security issues",
    ]);
    expect(diagnosis.askUser[0]?.text).toBe(
      "Open Search Console → Security & Manual Actions → Manual actions. Agentelse can't see this report.",
    );
    expect(diagnosis.askUser[1]?.text).toContain("Security issues");
  });
});

describe("diagnoseSearchDrop evidence numbers", () => {
  const inputs: [string, DiagnoseInput][] = [
    ["no drop", NO_DROP_DRILL],
    ...(Object.entries(DIAGNOSE_DRILLS) as [string, DiagnoseInput][]),
    [
      "stale data",
      {
        ...NO_DROP_DRILL,
        data: {
          ...NO_DROP_DRILL.data,
          finalThrough: "2026-09-20",
          missingDays: 2,
          freshDays: 1,
        },
      },
    ],
  ];

  it.each(inputs)("supports every evidence number (%s)", (_name, input) => {
    const diagnosis = diagnoseSearchDrop(input);
    for (const step of diagnosis.steps) {
      const summary = {
        headline: "",
        highlights: step.evidence,
        watchouts: [],
        nextSteps: [],
      };
      const allowed = allowedNumbersOf({ input, metrics: step.metrics });
      expect(checkSummaryNumbers(summary, allowed)).toEqual(summary);

      // Sıkı denetim: yalnız metrikler ile Google'ın adları/başlıkları.
      const strict = allowedNumbersOf({
        metrics: step.metrics,
        text: [
          ...input.updates.map((update) => update.name),
          ...input.health.alerts.map((alert) => alert.title),
        ],
      });
      const unsupported = step.evidence
        .flatMap((line) => numberTokens(line))
        .filter(
          (token) =>
            !strict.some(
              (value) =>
                Math.abs(value - Number(token.replace(/,/g, ""))) < 0.51,
            ),
        );
      expect(unsupported, `${step.key}: ${step.evidence.join(" | ")}`).toEqual(
        [],
      );
    }
  });
});
