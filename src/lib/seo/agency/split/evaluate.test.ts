import { describe, expect, it } from "vitest";

import {
  differenceInDifferences,
  didMetricFor,
  seededRandom,
  windowTotals,
  type PageSeries,
} from "@/lib/seo/actions/did";
import { ACTION_WINDOW_DAYS } from "@/lib/seo/actions/lifecycle";
import { evaluationWindows } from "@/lib/seo/actions/windows";
import { priorCurve } from "@/lib/seo/ctr-curve";

import {
  SPLIT_MIN_USABLE_PAGES,
  evaluateSplit,
  splitFixKind,
  splitMetric,
  splitWindowDays,
  type SplitEvaluationInput,
} from "./evaluate";
import { SPLIT_CHANGE_KINDS } from "./types";

// Bu dosyanın kanıtladığı (sentetik 8 önceki + 4 sonraki hafta, 180 + 180
// sayfa): etkisiz test INCONCLUSIVE; test kolunda +%30 WORKED (alt sınır > 0);
// -%20 DIDNT; ölçüt tür başına didMetricFor'dan gelir; önceden ayrışan kollar
// plasebo ile PRE_TREND olur; plasebo payı aralığı ham fark-farkına göre
// genişletir; Google güncellemesi kesin sonucu INCONCLUSIVE yapar; küçük kollar
// DIRECTIONAL; 3'ten az kontrol NO_DATA; az veri LOW_DATA; tohumla belirlidir.

const WINDOWS = evaluationWindows({
  measureFrom: new Date("2026-08-05T12:00:00.000Z"),
  windowDays: 28,
});
const CURVE = priorCurve("non-brand");
const NOW = new Date("2026-09-10T12:00:00.000Z");

function arms(opts: {
  lift: number;
  noise: number;
  drift?: number;
  dataSeed?: string;
  pages?: number;
}) {
  const weeks = [...WINDOWS.preWeeks, ...WINDOWS.postWeeks];
  const random = seededRandom(opts.dataSeed ?? "d5");
  const make = (arm: "t" | "c", index: number): PageSeries => {
    const base = 10 + Math.floor(random() * 40);
    return {
      pageId: `${arm}${index}`,
      weeks: weeks.map((weekStart, weekIndex) => {
        const post = weekIndex >= WINDOWS.preWeeks.length;
        const factor =
          (1 + (random() - 0.5) * 2 * opts.noise) *
          (post && arm === "t" ? 1 + opts.lift : 1) *
          (arm === "t" ? 1 + (opts.drift ?? 0) * weekIndex : 1);
        const impressions = Math.round(base * 20 * (1 + (random() - 0.5) * 0.2));
        const clicks = Math.round(impressions * 0.05 * factor);
        return {
          weekStart,
          clicks,
          impressions,
          positionWeighted: impressions * 5,
        };
      }),
    };
  };
  const count = opts.pages ?? 180;
  return {
    test: Array.from({ length: count }, (_, index) => make("t", index)),
    control: Array.from({ length: count }, (_, index) => make("c", index)),
  };
}

function input(
  data: { test: PageSeries[]; control: PageSeries[] },
  over: Partial<SplitEvaluationInput> = {},
): SplitEvaluationInput {
  return {
    kind: "TITLE_META",
    test: data.test,
    control: data.control,
    windows: WINDOWS,
    curve: CURVE,
    seed: "test-1",
    overlap: false,
    truncated: false,
    assigned: { test: 180, control: 180 },
    excluded: 0,
    updates: [],
    now: NOW,
    ...over,
  };
}

describe("kind mapping", () => {
  it("maps every kind to an SC-F6 fix kind and window", () => {
    expect(splitFixKind("INTERNAL_LINKS_BLOCK")).toBe("INTERNAL_LINKS");
    expect(splitFixKind("CONTENT_BLOCK")).toBe("CONTENT_REFRESH");
    expect(splitFixKind("TEMPLATE_CHANGE")).toBe("TECH_FIX");
    expect(splitFixKind("OTHER")).toBe("TECH_FIX");
    for (const kind of SPLIT_CHANGE_KINDS) {
      expect(splitWindowDays(kind)).toBe(ACTION_WINDOW_DAYS[splitFixKind(kind)]);
    }
  });

  it("derives the metric from didMetricFor", () => {
    expect(splitMetric("TITLE_META")).toBe("ctr_adj");
    expect(splitMetric("SCHEMA")).toBe("ctr_adj");
    expect(splitMetric("CONTENT_BLOCK")).toBe("clicks");
    expect(splitMetric("INTERNAL_LINKS_BLOCK")).toBe("impressions");
    expect(splitMetric("OTHER")).toBe(didMetricFor("TECH_FIX") ?? "clicks");
  });
});

describe("evaluateSplit", () => {
  it("calls a no-effect test inconclusive", () => {
    const result = evaluateSplit(input(arms({ lift: 0, noise: 0.8 })));
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.reason).toBeNull();
    expect(result.placebo?.passed).toBe(true);
  });

  it("calls +30% on the test arm worked with a positive lower bound", () => {
    const result = evaluateSplit(input(arms({ lift: 0.3, noise: 0.8 })));
    expect(result.outcome).toBe("WORKED");
    expect(result.low).toBeGreaterThan(0);
    expect(result.effect).toBeGreaterThan(0.1);
    expect(result.confidence).toBe("SIGNIFICANT");
    expect(result.method).toBe("DID");
    expect(result.usedTest).toBe(180);
    expect(result.testPages).toBe(180);
  });

  it("calls -20% on the test arm didn't work", () => {
    const result = evaluateSplit(input(arms({ lift: -0.2, noise: 0.8 })));
    expect(result.outcome).toBe("DIDNT");
    expect(result.high).toBeLessThan(0.05);
  });

  it("uses the ctr_adj metric and the curve for title tests", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    const result = evaluateSplit(input(data));
    expect(result.metric).toBe("ctr_adj");
    expect(result.treated?.before.ctrAdj).toBe(
      windowTotals(data.test, WINDOWS.preWeeks, CURVE).ctrAdj,
    );
    expect(result.treated?.before.ctrAdj).not.toBeNull();
  });

  it("uses another metric for another kind", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    expect(evaluateSplit(input(data, { kind: "CONTENT_BLOCK" })).metric).toBe("clicks");
    expect(evaluateSplit(input(data, { kind: "INTERNAL_LINKS_BLOCK" })).metric).toBe(
      "impressions",
    );
  });

  it("fails the placebo when the arms were already diverging", () => {
    const result = evaluateSplit(
      input(arms({ lift: 0, noise: 0.4, drift: 0.03, dataSeed: "data" })),
    );
    expect(result.placebo?.passed).toBe(false);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.reason).toBe("PRE_TREND");
  });

  it("widens the interval by the placebo padding", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    const result = evaluateSplit(input(data));
    const raw = differenceInDifferences({
      treated: data.test,
      controls: data.control,
      method: "DID",
      preWeeks: WINDOWS.preWeeks,
      postWeeks: WINDOWS.postWeeks,
      metric: "ctr_adj",
      curve: CURVE,
      seed: "test-1",
      samples: 1000,
    });
    const padding = result.placebo?.padding ?? 0;
    expect(padding).toBeGreaterThan(0);
    expect(result.low).toBeCloseTo((raw?.low ?? 0) - padding, 10);
    expect(result.high).toBeCloseTo((raw?.high ?? 0) + padding, 10);
    expect(result.effect).toBeCloseTo(raw?.effect ?? 0, 10);
  });

  it("skips the placebo with fewer than four pre weeks", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    const result = evaluateSplit(
      input(data, { windows: { ...WINDOWS, preWeeks: WINDOWS.preWeeks.slice(0, 3) } }),
    );
    expect(result.placebo).toBeNull();
  });

  it("caps a decisive result when a Google update overlaps", () => {
    const result = evaluateSplit(
      input(arms({ lift: 0.3, noise: 0.8 }), {
        overlap: true,
        updates: [
          { name: "Core update", kind: "CORE", startedAt: "2026-08-10T00:00:00.000Z", endedAt: null },
        ],
      }),
    );
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.reason).toBe("GOOGLE_UPDATE");
    expect(result.updates).toHaveLength(1);
  });

  it("downgrades to DIRECTIONAL when the assigned arms are small", () => {
    const result = evaluateSplit(
      input(arms({ lift: 0.3, noise: 0.8 }), { assigned: { test: 60, control: 60 } }),
    );
    expect(result.outcome).toBe("WORKED");
    expect(result.confidence).toBe("DIRECTIONAL");
  });

  it("downgrades to DIRECTIONAL when the data was truncated", () => {
    const result = evaluateSplit(
      input(arms({ lift: 0.3, noise: 0.8 }), { truncated: true }),
    );
    expect(result.confidence).toBe("DIRECTIONAL");
    expect(result.truncated).toBe(true);
  });

  it("reports NO_DATA with fewer than three control pages", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    const result = evaluateSplit(input({ test: data.test, control: data.control.slice(0, 2) }));
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.reason).toBe("NO_DATA");
  });

  it("reports LOW_DATA when an arm has fewer than 20 usable pages", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    const result = evaluateSplit(
      input({ test: data.test.slice(0, SPLIT_MIN_USABLE_PAGES - 1), control: data.control }),
    );
    expect(result.reason).toBe("LOW_DATA");
    const ok = evaluateSplit(
      input({ test: data.test.slice(0, SPLIT_MIN_USABLE_PAGES), control: data.control }),
    );
    expect(ok.reason).not.toBe("LOW_DATA");
  });

  it("reports LOW_DATA when the pre clicks are tiny", () => {
    const tiny = arms({ lift: 0, noise: 0.8, pages: 30 });
    const quiet = (series: PageSeries[]): PageSeries[] =>
      series.map((page) => ({
        ...page,
        weeks: page.weeks.map((week) => ({ ...week, clicks: 0, impressions: 1, positionWeighted: 5 })),
      }));
    const result = evaluateSplit(
      input({ test: quiet(tiny.test), control: quiet(tiny.control) }, { assigned: { test: 30, control: 30 } }),
    );
    expect(result.reason).toBe("LOW_DATA");
  });

  it("is deterministic for a seed", () => {
    const data = arms({ lift: 0.3, noise: 0.8 });
    expect(evaluateSplit(input(data))).toEqual(evaluateSplit(input(data)));
  });
});
