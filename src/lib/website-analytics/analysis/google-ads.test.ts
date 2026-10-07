import { describe, expect, it } from "vitest";

import type { GoogleAdsCampaignRow } from "@/lib/website-analytics/attribution/types";

import { evaluateGoogleAds, maskedAdsCampaign } from "./google-ads";
import { findingDetail, findingFacts } from "./describe";
import {
  makeAdsInput,
  makeGoogleAdsRow,
  makeWeeklyInput,
} from "./test-fixtures";
import type { An14Evidence, GaFindingCandidate } from "./types";
import type { GaFindingView } from "./view-types";

// AN14: Google Ads kampanyasında key event başına maliyet iki 28 günlük
// pencere arasında. Kapılar: ≥ 100 tıklama, ≥ 10 key event, maliyet > 0 iki
// pencerede de; p < 0,05, BH q = 0,10 ve |değişim| ≥ %20.

function run(
  current: GoogleAdsCampaignRow[],
  previous: GoogleAdsCampaignRow[],
): GaFindingCandidate[] {
  return evaluateGoogleAds(
    makeWeeklyInput({
      ads: makeAdsInput({ googleAds: { current, previous } }),
    }),
  );
}

function row(partial: Partial<GoogleAdsCampaignRow>): GoogleAdsCampaignRow {
  return makeGoogleAdsRow(partial);
}

function evidenceOf(candidate: GaFindingCandidate): An14Evidence {
  if (candidate.evidence.rule !== "AN14") throw new Error("not AN14");
  return candidate.evidence;
}

// 1000 € ile 20 key event (50 €) bir öncekinde 40 key event (25 €).
const WORSE = [row({ keyEvents: 20 })];
const BEFORE = [row({ keyEvents: 40 })];

describe("maskedAdsCampaign", () => {
  it("masks e-mail addresses and caps at 80 characters", () => {
    expect(maskedAdsCampaign("  promo jane@example.com  ")).toBe(
      "promo [email]",
    );
    expect(maskedAdsCampaign("x".repeat(200))).toHaveLength(80);
  });
});

describe("evaluateGoogleAds", () => {
  it("returns nothing without google ads input", () => {
    expect(evaluateGoogleAds(makeWeeklyInput())).toEqual([]);
    expect(
      evaluateGoogleAds(makeWeeklyInput({ ads: makeAdsInput() })),
    ).toEqual([]);
  });

  it("a higher cost per key event is a significant CHANGE WARN", () => {
    const [candidate] = run(WORSE, BEFORE);
    expect(candidate).toMatchObject({
      ruleKey: "AN14",
      kind: "CHANGE",
      severity: "WARN",
      confidence: "SIGNIFICANT",
      subject: "google_ads:Brand search",
      impact: null,
    });
    const evidence = evidenceOf(candidate!);
    expect(evidence.direction).toBe("worse");
    expect(evidence.changePct).toBe(100);
    expect(evidence.current.costPerKeyEvent).toBe(50);
    expect(evidence.previous.costPerKeyEvent).toBe(25);
    expect(evidence.current.roas).toBe(4);
    expect(evidence.bhAccepted).toBe(true);
    expect(evidence.p).toBeLessThan(0.05);
    // |değişim|/100 sınırlanır, ×0,5.
    expect(candidate!.impactShare).toBeCloseTo(0.5, 6);
  });

  it("a lower cost per key event is a WIN INFO", () => {
    const [candidate] = run(BEFORE, WORSE);
    expect(candidate).toMatchObject({ kind: "WIN", severity: "INFO" });
    const evidence = evidenceOf(candidate!);
    expect(evidence.direction).toBe("better");
    expect(evidence.changePct).toBe(-50);
  });

  it("ignores a campaign below the click, key event or cost gates", () => {
    expect(run([row({ keyEvents: 20, clicks: 99 })], BEFORE)).toEqual([]);
    expect(run(WORSE, [row({ keyEvents: 40, clicks: 99 })])).toEqual([]);
    expect(run([row({ keyEvents: 9 })], BEFORE)).toEqual([]);
    expect(run(WORSE, [row({ keyEvents: 9 })])).toEqual([]);
    expect(run([row({ keyEvents: 20, cost: 0 })], BEFORE)).toEqual([]);
    expect(run(WORSE, [row({ keyEvents: 40, cost: 0 })])).toEqual([]);
  });

  it("ignores a campaign that is missing in the previous window", () => {
    expect(run(WORSE, [row({ campaign: "Other", keyEvents: 40 })])).toEqual(
      [],
    );
  });

  it("a 15% change is not reported even when it is significant", () => {
    const current = [row({ cost: 10000, keyEvents: 4000, clicks: 9000 })];
    const previous = [row({ cost: 10000, keyEvents: 3400, clicks: 9000 })];
    expect(run(current, previous)).toEqual([]);
  });

  it("BH rejects a borderline campaign among many noisy ones", () => {
    // 36 key event ↔ 20 (p ≈ 0,03), tek başına kabul edilir.
    const target = [row({ campaign: "Target", keyEvents: 36 })];
    const before = [row({ campaign: "Target", keyEvents: 20 })];
    expect(run(target, before)).toHaveLength(1);
    const noiseNow = Array.from({ length: 30 }, (_, index) =>
      row({ campaign: `Noise ${index}`, keyEvents: 20 }),
    );
    const noiseBefore = Array.from({ length: 30 }, (_, index) =>
      row({ campaign: `Noise ${index}`, keyEvents: 20 }),
    );
    expect(run([...target, ...noiseNow], [...before, ...noiseBefore])).toEqual(
      [],
    );
  });

  it("keeps at most three, by |change| x cost", () => {
    const names = ["A", "B", "C", "D"];
    const current = names.map((campaign, index) =>
      row({ campaign, keyEvents: 20, cost: 1000 * (index + 1) }),
    );
    const previous = names.map((campaign, index) =>
      row({ campaign, keyEvents: 40, cost: 1000 * (index + 1) }),
    );
    const result = run(current, previous);
    expect(result.map((c) => c.subject)).toEqual([
      "google_ads:D",
      "google_ads:C",
      "google_ads:B",
    ]);
  });

  it("sums rows that share a campaign name", () => {
    const current = [
      row({ keyEvents: 10, cost: 500, clicks: 250 }),
      row({ keyEvents: 10, cost: 500, clicks: 250 }),
    ];
    const [candidate] = run(current, BEFORE);
    expect(evidenceOf(candidate!).current).toMatchObject({
      cost: 1000,
      keyEvents: 20,
      clicks: 500,
    });
  });

  it("revenue 0 gives a null ROAS", () => {
    const [candidate] = run(
      [row({ keyEvents: 20, revenue: 0 })],
      [row({ keyEvents: 40, revenue: 0 })],
    );
    const evidence = evidenceOf(candidate!);
    expect(evidence.current.roas).toBeNull();
    expect(evidence.previous.roas).toBeNull();
  });

  it("never lets a raw campaign name with an e-mail address out", () => {
    const raw = "Promo jane.doe@example.com spring";
    const [candidate] = run(
      [row({ campaign: raw, keyEvents: 20 })],
      [row({ campaign: raw, keyEvents: 40 })],
    );
    expect(candidate).toBeDefined();
    expect(evidenceOf(candidate!).campaign).toBe("Promo [email] spring");
    expect(candidate!.subject).toBe("google_ads:Promo [email] spring");
    const view = viewOf(candidate!);
    expect(findingDetail(view, { currency: "EUR" })).toContain("[email]");
    expect(JSON.stringify(findingFacts(view, { currency: "EUR" }))).not.toContain(
      "example.com",
    );
    expect(JSON.stringify(candidate)).not.toContain("jane.doe");
    expect(JSON.stringify(candidate)).not.toContain("example.com");
    expect(findingDetail(view, { currency: "EUR" })).not.toContain(
      "example.com",
    );
  });

  it("records excluded days and holidays of both windows", () => {
    const input = makeWeeklyInput({
      holidays: new Set(["2026-08-15", "2026-09-10"]),
      ads: makeAdsInput({
        googleAds: { current: WORSE, previous: BEFORE },
      }),
    });
    input.window28.excludedDays.push("2026-09-20");
    input.window28Previous.excludedDays.push("2026-08-20");
    const [candidate] = evaluateGoogleAds(input);
    const evidence = evidenceOf(candidate!);
    expect(evidence.excludedDays).toEqual(["2026-08-20", "2026-09-20"]);
    expect(evidence.holidays).toEqual(["2026-08-15", "2026-09-10"]);
  });
});

function viewOf(candidate: GaFindingCandidate): GaFindingView {
  return {
    id: "f1",
    ruleKey: candidate.ruleKey,
    kind: candidate.kind,
    subject: candidate.subject,
    subjectLabel: candidate.subject,
    period: candidate.period,
    severity: candidate.severity,
    confidence: candidate.confidence,
    status: "OPEN",
    mode: "live",
    priority: 0.5,
    evidence: candidate.evidence,
    impact: candidate.impact,
    explanation: null,
    occurrences: 1,
    evaluable: false,
    preliminary: false,
    createdAt: "2026-10-06T08:00:00.000Z",
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    reviewVerdict: null,
  };
}
