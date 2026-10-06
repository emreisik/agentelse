import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/website-analytics/days";
import type { GaTableRow as GaTableRowLike } from "@/lib/website-analytics/slices";

import { evaluateAiReferrals } from "./ai-referrals";
import type {
  An7Evidence,
  GaWeeklyAnalysisInput,
  GaWindowTables,
} from "./types";

const MONDAY = "2026-09-28";
const SUNDAY = "2026-10-04";

function tables(
  from: string,
  to: string,
  sourceMedium: GaTableRowLike[],
  sessions = 5_000,
): GaWindowTables {
  return {
    from,
    to,
    days: 28,
    usedDays: 28,
    excludedDays: [],
    missingDays: 0,
    totals: {
      sessions,
      engagedSessions: 0,
      keyEvents: 0,
      revenue: 0,
      transactions: 0,
      engagementSec: 0,
      screenPageViews: 0,
    },
    channel: [],
    landing: [],
    landingOther: null,
    sourceMedium,
    campaign: [],
    device: [],
    country: [],
    pages: [],
    events: [],
    newReturning: [],
    quality: { thresholded: false, otherRow: false, truncated: false },
    coverage: {},
  };
}

function rows(entries: [string, number, number?][]): GaTableRowLike[] {
  return entries.map(([source, sessions, keyEvents]) => ({
    key: [source, "referral"],
    values: [sessions, 0, keyEvents ?? 0],
  }));
}

function input(
  current: [string, number, number?][],
  previous: [string, number, number?][],
  holidays: string[] = [],
): GaWeeklyAnalysisInput {
  return {
    linkId: "link-1",
    today: "2026-10-05",
    week: { monday: MONDAY, sunday: SUNDAY },
    country: null,
    days: [],
    suspect: new Set(),
    holidays: new Set(holidays),
    current: tables(MONDAY, SUNDAY, []),
    previous: tables(addDays(MONDAY, -7), addDays(SUNDAY, -7), []),
    lastYear: null,
    window28: tables(
      addDays(SUNDAY, -27),
      SUNDAY,
      rows([["google", 4_000], ...current]),
    ),
    window28Previous: tables(
      addDays(SUNDAY, -55),
      addDays(SUNDAY, -28),
      rows([["google", 4_000], ...previous]),
    ),
    weeks: [],
    month: null,
    siteSearch: null,
    currency: null,
    measurementDegraded: false,
  };
}

describe("evaluateAiReferrals", () => {
  it.each([
    [9, false],
    [10, true],
  ])("%d current sessions → candidate %s", (sessions, found) => {
    const candidate = evaluateAiReferrals(
      input([["chatgpt.com", sessions]], []),
    );
    expect(candidate !== null).toBe(found);
  });

  it("is a DIRECTIONAL first-seen win below 3 previous sessions", () => {
    const candidate = evaluateAiReferrals(
      input(
        [
          ["chatgpt.com", 8, 1],
          ["www.perplexity.ai", 4],
          ["gemini.google.com", 1],
        ],
        [["chatgpt.com", 2]],
        ["2026-09-30"],
      ),
    )!;
    const evidence = candidate.evidence as An7Evidence;
    expect(candidate).toMatchObject({
      ruleKey: "AN7",
      kind: "WIN",
      severity: "INFO",
      confidence: "DIRECTIONAL",
      subject: "ai:assistants",
      period: {
        grain: "WINDOW28",
        from: "2026-09-07",
        to: SUNDAY,
        key: "2026-W40:28d",
      },
      impact: null,
    });
    expect(evidence.firstSeen).toBe(true);
    expect(evidence.current).toMatchObject({ sessions: 13, keyEvents: 1 });
    expect(evidence.previous.sessions).toBe(2);
    expect(evidence.assistants).toEqual([
      { name: "ChatGPT", sessions: 8, previousSessions: 2 },
      { name: "Perplexity", sessions: 4, previousSessions: 0 },
      { name: "Gemini", sessions: 1, previousSessions: 0 },
    ]);
    expect(evidence.holidays).toEqual(["2026-09-30"]);
    expect(evidence.siteSessions).toBe(5_000);
    expect(candidate.impactShare).toBeCloseTo(13 / 5_000, 9);
  });

  it.each([
    [149, null],
    [150, "SIGNIFICANT"],
  ])("+%d vs 100 previous → %s", (sessions, confidence) => {
    const candidate = evaluateAiReferrals(
      input([["chatgpt.com", sessions]], [["chatgpt.com", 100]]),
    );
    if (confidence === null) {
      expect(candidate).toBeNull();
      return;
    }
    expect(candidate!.confidence).toBe(confidence);
    const evidence = candidate!.evidence as An7Evidence;
    expect(evidence.changePct).toBeCloseTo(50, 9);
    expect(evidence.p!).toBeLessThan(0.05);
    expect(evidence.firstSeen).toBe(false);
  });

  it("gives no candidate for big growth that is not significant", () => {
    expect(
      evaluateAiReferrals(input([["chatgpt.com", 10]], [["chatgpt.com", 5]])),
    ).toBeNull();
  });

  it("keeps at most five assistants", () => {
    const candidate = evaluateAiReferrals(
      input(
        [
          ["chatgpt.com", 6],
          ["perplexity.ai", 5],
          ["gemini.google.com", 4],
          ["copilot.microsoft.com", 3],
          ["claude.ai", 2],
          ["grok.com", 1],
        ],
        [],
      ),
    )!;
    expect(
      (candidate.evidence as An7Evidence).assistants.map((a) => a.name),
    ).toEqual(["ChatGPT", "Perplexity", "Gemini", "Copilot", "Claude"]);
  });
});
