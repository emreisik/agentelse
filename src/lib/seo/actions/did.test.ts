import { describe, expect, it } from "vitest";

import { expectedCtr, priorCurve } from "@/lib/seo/ctr-curve";
import { addWeeks } from "@/lib/seo/dates";

import {
  alignWeeks,
  controlBasis,
  decideAlert,
  decideCwv,
  decideLaunch,
  decideOutcome,
  decideSitemap,
  didMetricFor,
  differenceInDifferences,
  quantile,
  seededRandom,
  selectControls,
  windowTotals,
  type DidResult,
  type PageSeries,
} from "./did";
import { weekSeries } from "./test-support";
import { SEO_FIX_KINDS } from "./types";
import { yearAgoWeeks } from "./windows";

// Bu dosyanın kabul testi: "DiD and bootstrap tests pass". Kanıtladığı: etki
// kestirimi, bootstrap aralığının tohumla tekrarlanabilirliği, kontrol seçimi,
// geçen yıl düzeltmesi ve karar kurallarının sınırları ve öncelikleri.

const PRE_START = "2026-07-06";
const PRE = Array.from({ length: 8 }, (_, i) => addWeeks(PRE_START, i));
const POST = ["2026-09-14", "2026-09-21"];
const curve = priorCurve("non-brand");

type V = number | { clicks: number; impressions: number; position?: number };

function series(id: string, pre: V[], post: V[]): PageSeries {
  return {
    pageId: id,
    weeks: [
      ...weekSeries(id, PRE[0]!, pre).weeks,
      ...weekSeries(id, POST[0]!, post).weeks,
    ],
  };
}

function flat(id: string, pre: number, post: number): PageSeries {
  return series(id, Array<V>(8).fill(pre), Array<V>(2).fill(post));
}

function controlsOf(count: number, level = 1000, post = level): PageSeries[] {
  return Array.from({ length: count }, (_, i) => flat(`c${i}`, level, post));
}

// Tohumlu, tekrarlanabilir gürültü (-amp..+amp).
function noise(seed: string, length: number, amp: number): number[] {
  const random = seededRandom(seed);
  return Array.from({ length }, () => (random() * 2 - 1) * amp);
}

function run(
  treated: PageSeries,
  controls: PageSeries[],
  over: Partial<Parameters<typeof differenceInDifferences>[0]> = {},
) {
  return differenceInDifferences({
    treated: [treated],
    controls,
    method: "DID",
    preWeeks: PRE,
    postWeeks: POST,
    metric: "clicks",
    curve,
    seed: "action-1",
    ...over,
  });
}

describe("didMetricFor", () => {
  it("maps kinds to metrics", () => {
    expect(didMetricFor("TITLE_META")).toBe("ctr_adj");
    expect(didMetricFor("SCHEMA")).toBe("ctr_adj");
    expect(didMetricFor("CONTENT_REFRESH")).toBe("clicks");
    expect(didMetricFor("CONSOLIDATE")).toBe("clicks");
    expect(didMetricFor("INTERNAL_LINKS")).toBe("impressions");
    expect(didMetricFor("TECH_FIX")).toBe("impressions");
    for (const kind of ["NEW_CONTENT", "LOCALIZE", "CWV_FIX", "SITEMAP_FIX"] as const) {
      expect(didMetricFor(kind)).toBeNull();
    }
    expect(SEO_FIX_KINDS.filter((kind) => didMetricFor(kind) !== null)).toHaveLength(6);
  });
});

describe("seededRandom and quantile", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = seededRandom("seed");
    const b = seededRandom("seed");
    const first = Array.from({ length: 50 }, () => a());
    const second = Array.from({ length: 50 }, () => b());
    expect(first).toEqual(second);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    const other = seededRandom("other");
    expect(Array.from({ length: 5 }, () => other())).not.toEqual(first.slice(0, 5));
  });

  it("quantile follows type 7", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 10);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBe(0);
    const hundred = Array.from({ length: 101 }, (_, i) => i);
    expect(quantile(hundred, 0.05)).toBeCloseTo(5, 10);
    expect(quantile(hundred, 0.95)).toBeCloseTo(95, 10);
  });
});

describe("alignWeeks, windowTotals and controlBasis", () => {
  it("fills missing weeks with zeros", () => {
    const aligned = alignWeeks(weekSeries("p", PRE[0]!, [5, 6]), PRE.slice(0, 4));
    expect(aligned.map((week) => week.clicks)).toEqual([5, 6, 0, 0]);
    expect(aligned[3]?.weekStart).toBe(PRE[3]);
  });

  it("sums clicks and impressions and reports position and CTR_adj", () => {
    const a = weekSeries("a", PRE[0]!, [
      { clicks: 10, impressions: 100, position: 4 },
      { clicks: 20, impressions: 200, position: 4 },
    ]);
    const b = weekSeries("b", PRE[0]!, [{ clicks: 5, impressions: 100, position: 8 }]);
    const total = windowTotals([a, b], PRE.slice(0, 2), curve);
    expect(total.weeks).toBe(2);
    expect(total.clicks).toBe(35);
    expect(total.impressions).toBe(400);
    expect(total.ctr).toBeCloseTo(35 / 400, 10);
    expect(total.position).toBeCloseTo((100 * 4 + 200 * 4 + 100 * 8) / 400, 10);
    const expected =
      100 * expectedCtr(curve, 4) + 200 * expectedCtr(curve, 4) + 100 * expectedCtr(curve, 8);
    expect(total.ctrAdj).toBeCloseTo(35 / expected, 10);
  });

  it("returns nulls for an empty window", () => {
    const total = windowTotals([], PRE, curve);
    expect(total.clicks).toBe(0);
    expect(total.ctr).toBeNull();
    expect(total.position).toBeNull();
    expect(total.ctrAdj).toBeNull();
  });

  it("controlBasis uses clicks, or impressions for the impressions metric", () => {
    const page = flat("p", 100, 100);
    expect(controlBasis(page, PRE, "clicks")).toBe(800);
    expect(controlBasis(page, PRE, "ctr_adj")).toBe(800);
    expect(controlBasis(page, PRE, "impressions")).toBe(8000);
  });
});

describe("differenceInDifferences", () => {
  it("+25% treated with flat controls gives about +25% and WORKED", () => {
    const result = run(flat("t", 1000, 1250), controlsOf(4));
    expect(result).not.toBeNull();
    expect(Math.abs(result!.effect - 0.25)).toBeLessThan(0.02);
    expect(result!.low).toBeGreaterThan(0.1);
    expect(result!.yoyAdjusted).toBe(false);
    const decision = decideOutcome({
      result,
      method: "DID",
      metric: "clicks",
      preClicks: 8000,
      preImpressions: 80000,
      overlap: false,
      overlappingChange: false,
      truncated: false,
    });
    expect(decision).toEqual({ outcome: "WORKED", confidence: "SIGNIFICANT", reason: null });
  });

  it("both treated and controls +25% gives no effect", () => {
    const result = run(flat("t", 1000, 1250), controlsOf(4, 1000, 1250));
    expect(Math.abs(result!.effect)).toBeLessThan(0.02);
    const decision = decideOutcome({
      result,
      method: "DID",
      metric: "clicks",
      preClicks: 8000,
      preImpressions: 80000,
      overlap: false,
      overlappingChange: false,
      truncated: false,
    });
    expect(decision.outcome).toBe("DIDNT");
  });

  it("-20% treated is DIDNT", () => {
    const result = run(flat("t", 1000, 800), controlsOf(4));
    expect(Math.abs(result!.effect + 0.2)).toBeLessThan(0.02);
    expect(result!.high).toBeLessThan(0.05);
    expect(
      decideOutcome({
        result,
        method: "DID",
        metric: "clicks",
        preClicks: 8000,
        preImpressions: 80000,
        overlap: false,
        overlappingChange: false,
        truncated: false,
      }).outcome,
    ).toBe("DIDNT");
  });

  it("ctr_adj removes the position effect that clicks would show", () => {
    const impressions = 10000;
    const click = (position: number) => impressions * expectedCtr(curve, position);
    const make = (id: string, prePos: number, postPos: number) =>
      series(
        id,
        Array<V>(8).fill({ clicks: click(prePos), impressions, position: prePos }),
        Array<V>(2).fill({ clicks: click(postPos), impressions, position: postPos }),
      );
    const treated = make("t", 8, 4);
    const controls = [make("c0", 8, 8), make("c1", 8, 8), make("c2", 8, 8)];
    const adjusted = run(treated, controls, { metric: "ctr_adj" });
    const raw = run(treated, controls, { metric: "clicks" });
    expect(Math.abs(adjusted!.effect)).toBeLessThan(0.02);
    expect(raw!.effect).toBeGreaterThan(0.5);
  });

  it("is deterministic for a seed and varies with another", () => {
    const wobble = noise("w", 8, 0.3);
    const treated = series(
      "t",
      wobble.map((w) => 1000 * (1 + w)),
      [1300, 1250],
    );
    const controls = controlsOf(4);
    const a = run(treated, controls, { seed: "x" });
    const b = run(treated, controls, { seed: "x" });
    const c = run(treated, controls, { seed: "y" });
    expect(a).toEqual(b);
    expect(a!.effect).toBe(c!.effect);
    expect(a!.low).not.toBe(c!.low);
  });

  it("noise widens the interval", () => {
    const quiet = run(flat("t", 1000, 1250), controlsOf(4))!;
    const noisy = run(
      series(
        "t",
        noise("pre", 8, 0.4).map((w) => 1000 * (1 + w)),
        noise("post", 2, 0.4).map((w) => 1250 * (1 + w)),
      ),
      controlsOf(4),
    )!;
    expect(noisy.high - noisy.low).toBeGreaterThan((quiet.high - quiet.low) * 5);
  });

  it("returns null without pre or post weeks, or DID without controls", () => {
    expect(run(flat("t", 1, 1), controlsOf(3), { preWeeks: [] })).toBeNull();
    expect(run(flat("t", 1, 1), controlsOf(3), { postWeeks: [] })).toBeNull();
    expect(run(flat("t", 1000, 1250), [])).toBeNull();
  });

  it("uses the requested number of samples", () => {
    expect(run(flat("t", 1000, 1250), controlsOf(3), { samples: 50 })?.samples).toBe(50);
    expect(run(flat("t", 1000, 1250), controlsOf(3))?.samples).toBe(1000);
  });

  it("PRE_POST without year-ago data is a plain before/after", () => {
    const result = run(flat("t", 1000, 1300), [], { method: "PRE_POST" });
    expect(result!.yoyAdjusted).toBe(false);
    expect(Math.abs(result!.effect - 0.3)).toBeLessThan(0.02);
  });

  it("PRE_POST with year-ago data removes a seasonal +30%", () => {
    const weeks = [...PRE, ...POST];
    const agoWeeks = yearAgoWeeks(weeks);
    const ago: PageSeries = {
      pageId: "t",
      weeks: agoWeeks.map((weekStart, index) => ({
        weekStart,
        clicks: index < 8 ? 1000 : 1300,
        impressions: 10000,
        positionWeighted: 50000,
      })),
    };
    const result = run(flat("t", 1000, 1300), [], {
      method: "PRE_POST",
      yearAgo: [ago],
    });
    expect(result!.yoyAdjusted).toBe(true);
    expect(Math.abs(result!.effect)).toBeLessThan(0.02);
    // Geçen yıl düz olsaydı etki korunurdu.
    const flatAgo: PageSeries = {
      pageId: "t",
      weeks: agoWeeks.map((weekStart) => ({
        weekStart,
        clicks: 1000,
        impressions: 10000,
        positionWeighted: 50000,
      })),
    };
    const kept = run(flat("t", 1000, 1300), [], { method: "PRE_POST", yearAgo: [flatAgo] });
    expect(Math.abs(kept!.effect - 0.3)).toBeLessThan(0.02);
  });
});

describe("selectControls", () => {
  const treated = [flat("t", 1000, 1000)];
  const base = { treated, preWeeks: PRE, metric: "clicks" as const };

  it("keeps only candidates in the band, closest first", () => {
    const candidates = [
      flat("a", 1000, 1000),
      flat("b", 700, 700),
      flat("c", 1400, 1400),
      flat("far-high", 2000, 2000),
      flat("far-low", 300, 300),
    ];
    const selection = selectControls({ ...base, candidates, excluded: new Set() });
    expect(selection.method).toBe("DID");
    expect(selection.controls.map((c) => c.pageId)).toEqual(["a", "c", "b"]);
  });

  it("breaks ties by page id and never returns the treated page", () => {
    const candidates = [
      flat("t", 1000, 1000),
      flat("z", 1000, 1000),
      flat("m", 1000, 1000),
      flat("a", 1000, 1000),
    ];
    const selection = selectControls({ ...base, candidates, excluded: new Set() });
    expect(selection.controls.map((c) => c.pageId)).toEqual(["a", "m", "z"]);
  });

  it("drops excluded pages", () => {
    const candidates = [
      flat("a", 1000, 1000),
      flat("b", 1000, 1000),
      flat("c", 1000, 1000),
      flat("d", 1000, 1000),
    ];
    const selection = selectControls({ ...base, candidates, excluded: new Set(["a"]) });
    expect(selection.controls.map((c) => c.pageId)).toEqual(["b", "c", "d"]);
  });

  it("needs impressions in at least half of the pre weeks", () => {
    const sparse = series("sparse", [1000, 1000, 1000, 0, 0, 0, 0, 0], [1000, 1000]);
    const half = series("half", [1000, 1000, 1000, 1000, 0, 0, 0, 0], [1000, 1000]);
    const selection = selectControls({
      ...base,
      candidates: [sparse, half, flat("a", 1000, 1000), flat("b", 1000, 1000)],
      excluded: new Set(),
    });
    expect(selection.method).toBe("DID");
    expect(selection.controls.map((c) => c.pageId).sort()).toEqual(["a", "b", "half"]);
  });

  it("caps at ten controls", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      flat(`p${String(i).padStart(2, "0")}`, 1000 + i * 10, 1000),
    );
    const selection = selectControls({ ...base, candidates, excluded: new Set() });
    expect(selection.method).toBe("DID");
    expect(selection.controls).toHaveLength(10);
  });

  it("falls back to DID_SITE with all eligible candidates", () => {
    const candidates = [flat("a", 1000, 1000), flat("b", 5000, 5000), flat("c", 100, 100)];
    const selection = selectControls({ ...base, candidates, excluded: new Set() });
    expect(selection.method).toBe("DID_SITE");
    expect(selection.controls.map((c) => c.pageId).sort()).toEqual(["a", "b", "c"]);
  });

  it("falls back to PRE_POST when nothing is eligible", () => {
    const selection = selectControls({
      ...base,
      candidates: [series("x", Array<V>(8).fill(0), [5, 5])],
      excluded: new Set(),
    });
    expect(selection).toEqual({ method: "PRE_POST", controls: [] });
    expect(
      selectControls({ ...base, candidates: [], excluded: new Set() }).method,
    ).toBe("PRE_POST");
  });
});

describe("decideOutcome", () => {
  const result = (effect: number, low: number, high: number): DidResult => ({
    effect,
    low,
    high,
    logEffect: Math.log(1 + effect),
    samples: 1000,
    yoyAdjusted: false,
  });
  const decide = (
    over: Partial<Parameters<typeof decideOutcome>[0]> & { r?: DidResult | null },
  ) =>
    decideOutcome({
      result: over.r === undefined ? result(0.3, 0.2, 0.4) : over.r,
      method: "DID",
      metric: "clicks",
      preClicks: 500,
      preImpressions: 5000,
      overlap: false,
      overlappingChange: false,
      truncated: false,
      ...over,
    });

  it("a missing result is NO_DATA", () => {
    expect(decide({ r: null })).toEqual({
      outcome: "INCONCLUSIVE",
      confidence: "DIRECTIONAL",
      reason: "NO_DATA",
    });
  });

  it("WORKED boundary is an effect of 0.10 with a positive low end", () => {
    expect(decide({ r: result(0.0999, 0.02, 0.2) }).outcome).toBe("INCONCLUSIVE");
    expect(decide({ r: result(0.1, 0.02, 0.2) }).outcome).toBe("WORKED");
    expect(decide({ r: result(0.3, 0, 0.4) }).outcome).toBe("INCONCLUSIVE");
    expect(decide({ r: result(0.3, -0.01, 0.4) }).outcome).toBe("INCONCLUSIVE");
  });

  it("DIDNT boundary is a high end below 0.05", () => {
    expect(decide({ r: result(-0.1, -0.2, 0.0499) }).outcome).toBe("DIDNT");
    expect(decide({ r: result(-0.1, -0.2, 0.05) }).outcome).toBe("INCONCLUSIVE");
  });

  it("LOW_DATA beats an overlapping update", () => {
    expect(decide({ preImpressions: 99, overlap: true }).reason).toBe("LOW_DATA");
    expect(decide({ preClicks: 9, overlap: true }).reason).toBe("LOW_DATA");
    // Gösterim metriğinde tıklama eşiği aranmaz.
    expect(decide({ metric: "impressions", preClicks: 0, preImpressions: 600 }).outcome).toBe(
      "WORKED",
    );
    expect(decide({ metric: "impressions", preImpressions: 99 }).reason).toBe("LOW_DATA");
  });

  it("an overlapping update caps WORKED and DIDNT to GOOGLE_UPDATE", () => {
    expect(decide({ overlap: true })).toEqual({
      outcome: "INCONCLUSIVE",
      confidence: "DIRECTIONAL",
      reason: "GOOGLE_UPDATE",
    });
    expect(decide({ r: result(-0.3, -0.4, -0.2), overlap: true }).reason).toBe(
      "GOOGLE_UPDATE",
    );
  });

  it("with an INCONCLUSIVE base the reason stays null", () => {
    const decision = decide({ r: result(0.05, -0.1, 0.2), overlap: true });
    expect(decision.outcome).toBe("INCONCLUSIVE");
    expect(decision.reason).toBeNull();
    expect(decide({ r: result(0.05, -0.1, 0.2), overlappingChange: true }).reason).toBeNull();
  });

  it("an overlapping change caps a decisive result, after the update check", () => {
    expect(decide({ overlappingChange: true }).reason).toBe("OVERLAPPING_CHANGE");
    expect(decide({ overlappingChange: true, overlap: true }).reason).toBe("GOOGLE_UPDATE");
  });

  it("SIGNIFICANT only for DID, untruncated, with enough pre data", () => {
    expect(decide({}).confidence).toBe("SIGNIFICANT");
    expect(decide({ method: "DID_SITE" }).confidence).toBe("DIRECTIONAL");
    expect(decide({ method: "PRE_POST" }).confidence).toBe("DIRECTIONAL");
    expect(decide({ truncated: true }).confidence).toBe("DIRECTIONAL");
    expect(decide({ preClicks: 29 }).confidence).toBe("DIRECTIONAL");
    expect(decide({ preClicks: 30 }).confidence).toBe("SIGNIFICANT");
    expect(
      decide({ metric: "impressions", preClicks: 0, preImpressions: 499 }).confidence,
    ).toBe("DIRECTIONAL");
    expect(
      decide({ metric: "impressions", preClicks: 0, preImpressions: 500 }).confidence,
    ).toBe("SIGNIFICANT");
    expect(decide({ r: result(0.05, -0.1, 0.2) }).confidence).toBe("DIRECTIONAL");
  });
});

describe("decideLaunch", () => {
  it("follows the launch table", () => {
    expect(decideLaunch({ indexed: true, impressions: 100, clicks: 0 })).toEqual({
      outcome: "WORKED",
      reason: null,
    });
    expect(decideLaunch({ indexed: null, impressions: 0, clicks: 10 }).outcome).toBe("WORKED");
    expect(decideLaunch({ indexed: false, impressions: 50, clicks: 1 }).outcome).toBe("DIDNT");
    expect(decideLaunch({ indexed: true, impressions: 0, clicks: 0 }).outcome).toBe("DIDNT");
    expect(decideLaunch({ indexed: true, impressions: 40, clicks: 2 })).toEqual({
      outcome: "INCONCLUSIVE",
      reason: "LOW_DATA",
    });
    expect(decideLaunch({ indexed: null, impressions: 40, clicks: 2 }).outcome).toBe(
      "INCONCLUSIVE",
    );
  });
});

describe("decideCwv", () => {
  it("lower is better", () => {
    expect(decideCwv({ before: null, after: 2 })).toEqual({
      outcome: "INCONCLUSIVE",
      reason: "NO_DATA",
    });
    expect(decideCwv({ before: 3000, after: null }).reason).toBe("NO_DATA");
    expect(decideCwv({ before: 0, after: 0 }).reason).toBe("NO_DATA");
    expect(decideCwv({ before: 3000, after: 2700 }).outcome).toBe("WORKED");
    expect(decideCwv({ before: 3000, after: 2701 }).outcome).toBe("INCONCLUSIVE");
    expect(decideCwv({ before: 3000, after: 2850 }).outcome).toBe("DIDNT");
    expect(decideCwv({ before: 3000, after: 3500 }).outcome).toBe("DIDNT");
  });
});

describe("decideSitemap", () => {
  it("needs our own check and GSC to be clean", () => {
    expect(decideSitemap({ ownOk: true, gscErrors: 0 }).outcome).toBe("WORKED");
    expect(decideSitemap({ ownOk: true, gscErrors: null }).outcome).toBe("WORKED");
    expect(decideSitemap({ ownOk: true, gscErrors: 2 }).outcome).toBe("DIDNT");
    expect(decideSitemap({ ownOk: false, gscErrors: 0 }).outcome).toBe("DIDNT");
  });
});

describe("decideAlert", () => {
  it("maps the alert status", () => {
    expect(decideAlert("RESOLVED")).toEqual({ outcome: "WORKED", reason: null });
    for (const status of ["OPEN", "ACKED", "MUTED"]) {
      expect(decideAlert(status)).toEqual({ outcome: "DIDNT", reason: null });
    }
    expect(decideAlert(null)).toEqual({ outcome: "INCONCLUSIVE", reason: "ALERT_GONE" });
  });
});
