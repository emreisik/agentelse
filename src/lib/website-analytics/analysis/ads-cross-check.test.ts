import { describe, expect, it } from "vitest";

import { evaluateAdsCrossCheck } from "./ads-cross-check";
import {
  makeAdsCampaign,
  makeAdsInput,
  makeWeeklyInput,
} from "./test-fixtures";
import type { An13Evidence, GaFindingCandidate } from "./types";

// AN13: Meta tıklaması ↔ GA oturumu ve Meta sonucu ↔ GA key event
// karşılaştırması. Eşikler: ≥ 100 tıklama, ≥ 7 aktif gün, kayıp > %40
// (Wilson üst sınırı < 0,60 ise SIGNIFICANT), sonuç farkı > %30 (yalnız
// offsite_conversion.* ve ≥ 10 sayım, Poisson p < 0,05).

type Campaign = Parameters<typeof makeAdsCampaign>[0];

function run(...campaigns: ReturnType<typeof makeAdsCampaign>[]) {
  return evaluateAdsCrossCheck(
    makeWeeklyInput({ ads: makeAdsInput({ campaigns }) }),
  );
}

function one(partial: Campaign): GaFindingCandidate {
  const [found] = run(makeAdsCampaign(partial));
  if (!found) throw new Error("expected a candidate");
  return found;
}

function evidenceOf(candidate: GaFindingCandidate): An13Evidence {
  if (candidate.evidence.rule !== "AN13") throw new Error("not AN13");
  return candidate.evidence;
}

describe("evaluateAdsCrossCheck", () => {
  it("returns nothing without ads input", () => {
    expect(evaluateAdsCrossCheck(makeWeeklyInput())).toEqual([]);
    expect(evaluateAdsCrossCheck(makeWeeklyInput({ ads: null }))).toEqual([]);
  });

  it("returns nothing for a healthy campaign", () => {
    expect(run(makeAdsCampaign())).toEqual([]);
  });

  it("needs at least 100 link clicks", () => {
    expect(
      run(
        makeAdsCampaign({
          meta: { linkClicks: 99 },
          ga: { sessions: 10 },
        }),
      ),
    ).toEqual([]);
  });

  it("needs at least 7 active days", () => {
    expect(
      run(
        makeAdsCampaign({
          meta: { activeDays: 6 },
          ga: { sessions: 60 },
        }),
      ),
    ).toEqual([]);
  });

  it("200 clicks and 60 sessions is a significant WARN risk on clicks", () => {
    const candidate = one({ ga: { sessions: 60 } });
    expect(candidate).toMatchObject({
      ruleKey: "AN13",
      kind: "RISK",
      severity: "WARN",
      confidence: "SIGNIFICANT",
      subject: "meta_campaign:c1",
      impact: null,
    });
    const evidence = evidenceOf(candidate);
    expect(evidence.checks).toEqual(["clicks"]);
    expect(evidence.clickLoss).toBeCloseTo(0.7, 6);
    expect(evidence.clickRateHigh).not.toBeNull();
    expect(evidence.clickRateHigh!).toBeLessThan(0.6);
    expect(candidate.impactShare).toBeCloseTo(0.7, 6);
    expect(candidate.period.grain).toBe("WINDOW28");
  });

  it("120 clicks and 70 sessions is only directional (Wilson bound >= 0.60)", () => {
    const candidate = one({
      meta: { linkClicks: 120 },
      ga: { sessions: 70 },
    });
    expect(candidate).toMatchObject({
      confidence: "DIRECTIONAL",
      severity: "INFO",
    });
    expect(evidenceOf(candidate).checks).toEqual(["clicks"]);
    expect(evidenceOf(candidate).clickRateHigh!).toBeGreaterThanOrEqual(0.6);
  });

  it("a loss of 40% or less does not apply", () => {
    expect(run(makeAdsCampaign({ ga: { sessions: 120 } }))).toEqual([]);
  });

  it("a significant loss of 60% or less stays INFO", () => {
    // 200 tıklama, 90 oturum: kayıp %55, üst sınır < 0,60.
    const candidate = one({ ga: { sessions: 90 } });
    expect(candidate.confidence).toBe("SIGNIFICANT");
    expect(candidate.severity).toBe("INFO");
  });

  it("40 website results against 20 key events adds a results check with p", () => {
    const candidate = one({
      meta: { results: 40 },
      ga: { keyEvents: 20 },
    });
    const evidence = evidenceOf(candidate);
    expect(evidence.checks).toEqual(["results"]);
    expect(evidence.resultsGap).toBeCloseTo(0.5, 6);
    expect(evidence.resultsP).not.toBeNull();
    expect(evidence.resultsP!).toBeLessThan(0.05);
    expect(candidate).toMatchObject({
      confidence: "SIGNIFICANT",
      severity: "INFO",
    });
    expect(candidate.impactShare).toBeCloseTo(0.5, 6);
  });

  it("clicks and results checks can both apply", () => {
    const evidence = evidenceOf(
      one({
        ga: { sessions: 60, keyEvents: 20 },
        meta: { results: 40 },
      }),
    );
    expect(evidence.checks).toEqual(["clicks", "results"]);
  });

  it("a non-website result type never gets a results check", () => {
    expect(
      run(
        makeAdsCampaign({
          meta: { results: 40, resultActionType: "link_click" },
          ga: { keyEvents: 20 },
        }),
      ),
    ).toEqual([]);
    expect(
      run(
        makeAdsCampaign({
          meta: { results: 40, resultActionType: null },
          ga: { keyEvents: 20 },
        }),
      ),
    ).toEqual([]);
  });

  it("needs ten results or key events for the results check", () => {
    expect(
      run(
        makeAdsCampaign({
          meta: { results: 9 },
          ga: { keyEvents: 3 },
        }),
      ),
    ).toEqual([]);
  });

  it("keeps at most three campaigns, by link clicks", () => {
    const campaigns = [100, 500, 300, 400, 200].map((clicks, index) =>
      makeAdsCampaign({
        campaignExternalId: `c${index}`,
        meta: { linkClicks: clicks },
        ga: { sessions: Math.round(clicks * 0.2) },
      }),
    );
    const result = run(...campaigns);
    expect(result.map((c) => c.subject)).toEqual([
      "meta_campaign:c1",
      "meta_campaign:c3",
      "meta_campaign:c2",
    ]);
  });

  it("costPerKeyEvent is spend over key events, costPerResult spend over results", () => {
    const evidence = evidenceOf(
      one({
        meta: { spend: 600, results: 40 },
        ga: { sessions: 60, keyEvents: 20 },
      }),
    );
    expect(evidence.costPerKeyEvent).toBeCloseTo(30, 6);
    expect(evidence.costPerResult).toBeCloseTo(15, 6);
    expect(evidence.metaCurrency).toBe("EUR");
  });

  it("null spend (mixed currencies) gives null cost fields", () => {
    const evidence = evidenceOf(
      one({ meta: { spend: null }, ga: { sessions: 60 } }),
    );
    expect(evidence.costPerKeyEvent).toBeNull();
    expect(evidence.costPerResult).toBeNull();
    expect(evidence.meta.spend).toBeNull();
  });

  it("caps the label at 80 characters and records excluded days and holidays", () => {
    const input = makeWeeklyInput({
      holidays: new Set(["2026-09-10", "2026-01-01"]),
      ads: makeAdsInput({
        campaigns: [
          makeAdsCampaign({ label: "x".repeat(120), ga: { sessions: 60 } }),
        ],
      }),
    });
    input.window28.excludedDays.push("2026-09-20");
    const [candidate] = evaluateAdsCrossCheck(input);
    const evidence = evidenceOf(candidate!);
    expect(evidence.label).toHaveLength(80);
    expect(evidence.excludedDays).toEqual(["2026-09-20"]);
    expect(evidence.holidays).toEqual(["2026-09-10"]);
    expect(evidence.window).toEqual(input.ads!.window);
  });
});
