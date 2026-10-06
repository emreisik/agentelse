import { describe, expect, it } from "vitest";

import type { GaTableRow } from "@/lib/website-analytics/slices";

import { evaluateCampaigns, evaluateChannelQuality } from "./channels";
import { makeWeeklyInput, makeWindowTables } from "./test-fixtures";
import type {
  An4Evidence,
  An12Evidence,
  GaWeeklyAnalysisInput,
  GaWindowTotals,
} from "./types";

const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const W28 = { from: "2026-09-07", to: "2026-10-04" };

function totals(partial: Partial<GaWindowTotals>): GaWindowTotals {
  return {
    sessions: 0,
    engagedSessions: 0,
    keyEvents: 0,
    revenue: 0,
    transactions: 0,
    engagementSec: 0,
    screenPageViews: 0,
    ...partial,
  };
}

function channel(
  name: string,
  sessions: number,
  engaged: number,
  keyEvents: number,
): GaTableRow {
  return { key: [name], values: [sessions, engaged, keyEvents, 0] };
}

function campaign(
  name: string,
  sessions: number,
  keyEvents: number,
  source = "newsletter",
  medium = "email",
): GaTableRow {
  return {
    key: [name, source, medium],
    values: [sessions, sessions / 2, keyEvents, 0],
  };
}

function withChannels(
  rows: GaTableRow[],
  site: Partial<GaWindowTotals>,
): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    window28: makeWindowTables(W28, { channel: rows, totals: totals(site) }),
  });
}

function withCampaigns(
  rows: GaTableRow[],
  site: Partial<GaWindowTotals>,
): GaWeeklyAnalysisInput {
  return makeWeeklyInput({
    week: WEEK,
    window28: makeWindowTables(W28, { campaign: rows, totals: totals(site) }),
  });
}

describe("evaluateChannelQuality (AN4)", () => {
  // Geri kalan: 10000 oturum, %50 etkileşim, KE yok (KE testi kurulmaz).
  const engagementSite = (engaged: number) => ({
    sessions: 11_000,
    engagedSessions: 5_000 + engaged,
  });

  it("engagement ratio 0.70 is a RISK, 0.71 is not", () => {
    const at = evaluateChannelQuality(
      withChannels(
        [channel("Paid Social", 1_000, 350, 0)],
        engagementSite(350),
      ),
    );
    expect(at).toHaveLength(1);
    const candidate = at[0]!;
    const evidence = candidate.evidence as An4Evidence;
    expect(candidate.kind).toBe("RISK");
    expect(evidence.measure).toBe("engagement");
    expect(evidence.direction).toBe("below");
    expect(evidence.ratio).toBeCloseTo(0.7, 10);
    expect(candidate.subject).toBe("channel:Paid Social:engagement");
    expect(candidate.period.grain).toBe("WINDOW28");

    const over = evaluateChannelQuality(
      withChannels(
        [channel("Paid Social", 1_000, 355, 0)],
        engagementSite(355),
      ),
    );
    expect(over).toEqual([]);
  });

  it("engagement RISK carries impact and impact share", () => {
    const [candidate] = evaluateChannelQuality(
      withChannels(
        [channel("Paid Social", 1_000, 350, 0)],
        engagementSite(350),
      ),
    );
    // (0,5 − 0,35) · 1000 / 4
    const impact = candidate!.impact!;
    expect(impact.metric).toBe("engagedSessions");
    expect(impact.perWeek).toBeCloseTo(37.5, 10);
    expect(impact.low).toBe(impact.perWeek);
    expect(impact.high).toBe(impact.perWeek);
    expect(impact.directional).toBe(false);
    expect(candidate!.impactShare).toBeCloseTo(37.5 / (5_350 / 4), 10);
    expect(candidate!.confidence).toBe("SIGNIFICANT");
    expect(candidate!.severity).toBe("WARN");
  });

  it("key event rate ratio 1.30 is a WIN, 1.29 is not", () => {
    // Geri kalan: 10000 oturum, 1000 KE (oran 0,1); etkileşim eşit.
    const site = (keyEvents: number) => ({
      sessions: 11_000,
      engagedSessions: 5_500,
      keyEvents: 1_000 + keyEvents,
    });
    const at = evaluateChannelQuality(
      withChannels([channel("Email", 1_000, 500, 130)], site(130)),
    );
    expect(at).toHaveLength(1);
    expect(at[0]!.kind).toBe("WIN");
    expect(at[0]!.severity).toBe("INFO");
    const evidence = at[0]!.evidence as An4Evidence;
    expect(evidence.measure).toBe("keyEventRate");
    expect(evidence.direction).toBe("above");
    // 130 − 0,1 · 1000 = 30 → haftada 7,5
    expect(at[0]!.impact?.perWeek).toBeCloseTo(7.5, 10);
    expect(at[0]!.impact?.directional).toBe(true);
    expect(at[0]!.impactShare).toBeCloseTo(7.5 / (1_130 / 4), 10);

    expect(
      evaluateChannelQuality(
        withChannels([channel("Email", 1_000, 500, 129)], site(129)),
      ),
    ).toEqual([]);
  });

  it("needs ≥200 sessions", () => {
    const at = evaluateChannelQuality(
      withChannels([channel("Referral", 200, 0, 0)], {
        sessions: 10_200,
        engagedSessions: 5_000,
      }),
    );
    expect(at).toHaveLength(1);
    const under = evaluateChannelQuality(
      withChannels([channel("Referral", 199, 0, 0)], {
        sessions: 10_199,
        engagedSessions: 5_000,
      }),
    );
    expect(under).toEqual([]);
  });

  it("ignores Unassigned, (other) and (not set)", () => {
    const rows = ["Unassigned", "(other)", "(not set)"].map((name) =>
      channel(name, 1_000, 0, 0),
    );
    expect(
      evaluateChannelQuality(
        withChannels(rows, { sessions: 13_000, engagedSessions: 5_000 }),
      ),
    ).toEqual([]);
  });

  it("keeps at most 3 by impact share", () => {
    const rows = ["A", "B", "C", "D"].map((name, index) =>
      channel(name, 1_000, 100 + index * 10, 0),
    );
    const result = evaluateChannelQuality(
      withChannels(rows, { sessions: 20_000, engagedSessions: 9_000 }),
    );
    expect(result.map((c) => (c.evidence as An4Evidence).channel)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("evaluateCampaigns (AN12)", () => {
  const site = (sessions: number, keyEvents: number) => ({
    sessions: 10_000 + sessions,
    keyEvents: 1_000 + keyEvents,
  });

  it("needs ≥50 sessions", () => {
    expect(
      evaluateCampaigns(
        withCampaigns([campaign("spring", 50, 0)], site(50, 0)),
      ),
    ).toHaveLength(1);
    expect(
      evaluateCampaigns(
        withCampaigns([campaign("spring", 49, 0)], site(49, 0)),
      ),
    ).toEqual([]);
  });

  it("flags agentelse campaigns by the agx- prefix", () => {
    const [ours] = evaluateCampaigns(
      withCampaigns([campaign("AGX-spring", 400, 0)], site(400, 0)),
    );
    expect((ours!.evidence as An12Evidence).agentelse).toBe(true);
    const [theirs] = evaluateCampaigns(
      withCampaigns([campaign("spring", 400, 0)], site(400, 0)),
    );
    expect((theirs!.evidence as An12Evidence).agentelse).toBe(false);
  });

  it("masks campaign labels", () => {
    const [candidate] = evaluateCampaigns(
      withCampaigns(
        [campaign("promo jane@example.com", 400, 0, "x".repeat(120))],
        site(400, 0),
      ),
    );
    const evidence = candidate!.evidence as An12Evidence;
    expect(evidence.campaign).toBe("promo [email]");
    expect(evidence.source).toHaveLength(80);
    expect(candidate!.subject).toContain("promo [email]");
    expect(candidate!.subject).not.toContain("jane@");
  });

  it("below: RISK with impact and share", () => {
    const [candidate] = evaluateCampaigns(
      withCampaigns([campaign("spring", 400, 0)], site(400, 0)),
    );
    const evidence = candidate!.evidence as An12Evidence;
    expect(candidate!.kind).toBe("RISK");
    expect(evidence.direction).toBe("below");
    const perWeek = ((1_000 / 10_000) * 400) / 4;
    expect(candidate!.impact?.perWeek).toBeCloseTo(perWeek, 10);
    expect(candidate!.impact?.low).toBe(candidate!.impact?.perWeek);
    expect(candidate!.impact?.high).toBe(candidate!.impact?.perWeek);
    expect(candidate!.impactShare).toBeCloseTo(perWeek / (1_000 / 4), 10);
    expect(candidate!.confidence).toBe("SIGNIFICANT");
    expect(candidate!.severity).toBe("WARN");
    expect(candidate!.impact?.directional).toBe(false);
  });

  it("above: WIN with impact and share", () => {
    const [candidate] = evaluateCampaigns(
      withCampaigns([campaign("spring", 400, 100)], site(400, 100)),
    );
    const evidence = candidate!.evidence as An12Evidence;
    expect(candidate!.kind).toBe("WIN");
    expect(candidate!.severity).toBe("INFO");
    expect(evidence.direction).toBe("above");
    // 100 − 0,1 · 400 = 60 → haftada 15
    expect(candidate!.impact?.perWeek).toBeCloseTo(15, 10);
    expect(candidate!.impact?.directional).toBe(true);
    expect(candidate!.impactShare).toBeCloseTo(15 / (1_100 / 4), 10);
  });

  it("above needs ≥5 key events", () => {
    // oran 4/50 = 0,08 ≥ 1,5 · 0,01 ama KE 4
    expect(
      evaluateCampaigns(
        withCampaigns([campaign("tiny", 50, 4)], {
          sessions: 10_050,
          keyEvents: 104,
        }),
      ),
    ).toEqual([]);
    expect(
      evaluateCampaigns(
        withCampaigns([campaign("tiny", 50, 5)], {
          sessions: 10_050,
          keyEvents: 105,
        }),
      ),
    ).toHaveLength(1);
  });
});
