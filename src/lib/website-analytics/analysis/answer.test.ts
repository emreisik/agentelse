import { describe, expect, it } from "vitest";

import { daysInRange } from "@/lib/website-analytics/days";
import {
  allowedNumbersOf,
  keepSupportedSentences,
  numberTokens,
  readingsOf,
} from "@/lib/module-flows/analytics/number-check";

import { changeAnswer } from "./answer";
import { explainChange } from "./changes";
import type { An2Evidence, GaWindowTables } from "./types";

type Channel = [string, number, number, number?];

function tables(
  from: string,
  to: string,
  totals: {
    sessions: number;
    keyEvents?: number;
    revenue?: number;
    transactions?: number;
  },
  channel: Channel[],
): GaWindowTables {
  const days = daysInRange(from, to);
  return {
    from,
    to,
    days,
    usedDays: days,
    excludedDays: [],
    missingDays: 0,
    totals: {
      sessions: totals.sessions,
      engagedSessions: 0,
      keyEvents: totals.keyEvents ?? 0,
      revenue: totals.revenue ?? 0,
      transactions: totals.transactions ?? 0,
      engagementSec: 0,
      screenPageViews: 0,
    },
    channel: channel.map(([name, s, k, r]) => ({
      key: [name],
      values: [s, 0, k, r ?? 0],
    })),
    landing: [],
    landingOther: null,
    sourceMedium: [],
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

const CURRENT_CHANNELS: Channel[] = [
  ["Organic Search", 1_500, 90, 1_200.5],
  ["Direct", 800, 30, 300],
  ["Paid Search", 300, 12, 150],
  ["Referral", 100, 3, 0],
];
const PREVIOUS_CHANNELS: Channel[] = [
  ["Organic Search", 1_100, 50, 800.25],
  ["Direct", 820, 28, 310],
  ["Paid Search", 280, 10, 140],
  ["Referral", 90, 2, 0],
];

function evidenceFor(options: {
  current?: [string, string];
  previous?: [string, string];
  comparison?: "wow" | "yoy" | "mom";
  metric?: "auto" | "keyEvents" | "sessions" | "revenue";
  currentTotals?: {
    sessions: number;
    keyEvents?: number;
    revenue?: number;
    transactions?: number;
  };
  previousTotals?: {
    sessions: number;
    keyEvents?: number;
    revenue?: number;
    transactions?: number;
  };
  previousChannels?: Channel[];
  holidays?: string[];
  suspectDays?: string[];
  perDay?: boolean;
}) {
  const [cFrom, cTo] = options.current ?? ["2026-09-28", "2026-10-04"];
  const [pFrom, pTo] = options.previous ?? ["2026-09-21", "2026-09-27"];
  return explainChange({
    metric: options.metric ?? "auto",
    comparison: options.comparison ?? "wow",
    current: tables(
      cFrom,
      cTo,
      options.currentTotals ?? {
        sessions: 2_700,
        keyEvents: 135,
        revenue: 1_650.5,
        transactions: 40,
      },
      CURRENT_CHANNELS,
    ),
    previous: tables(
      pFrom,
      pTo,
      options.previousTotals ?? {
        sessions: 2_290,
        keyEvents: 90,
        revenue: 1_250.25,
        transactions: 30,
      },
      options.previousChannels ?? PREVIOUS_CHANNELS,
    ),
    perDay: options.perDay ?? false,
    holidays: options.holidays ?? [],
    suspectDays: options.suspectDays ?? [],
    seasonal: null,
  });
}

function answerOf(
  result: {
    evidence: An2Evidence;
    significance: "significant" | "not_significant" | "low_volume";
  },
  currency: string | null = null,
) {
  return changeAnswer({
    evidence: result.evidence,
    significance: result.significance,
    currency,
  });
}

// Metindeki her sayı facts'te AYNI değerle (yuvarlama payı olmadan) var.
function expectExactNumbers(answer: string, facts: Record<string, unknown>) {
  const allowed = allowedNumbersOf(facts);
  for (const token of numberTokens(answer)) {
    const found = readingsOf(token).some((reading) =>
      allowed.some((value) => Math.abs(value - reading) < 1e-9),
    );
    expect(found, `number ${token} is not in facts`).toBe(true);
  }
}

function expectChecked(answer: string, facts: Record<string, unknown>) {
  expect(keepSupportedSentences(answer, allowedNumbersOf(facts))).toBe(answer);
  expectExactNumbers(answer, facts);
}

describe("changeAnswer", () => {
  it("writes a significant key events change with components", () => {
    const result = evidenceFor({});
    expect(result.significance).toBe("significant");
    const { answer, facts } = answerOf(result);
    expect(
      answer.startsWith(
        "Key events were 135 in Sep 28 – Oct 4 against 90 in Sep 21 – Sep 27, up 45 (50%).",
      ),
    ).toBe(true);
    expect(answer).toContain("This change is statistically significant.");
    expect(answer).toContain(
      "Organic Search: gained 400 visits, which explains",
    );
    expect(answer).toContain("its conversion rate went from 4.5% to 6%");
    expectChecked(answer, facts);
  });

  it("writes a change within normal variation", () => {
    const result = evidenceFor({
      metric: "sessions",
      currentTotals: { sessions: 2_330 },
      previousTotals: { sessions: 2_290 },
    });
    expect(result.significance).toBe("not_significant");
    const { answer, facts } = answerOf(result);
    expect(answer).toContain(
      "Visits were 2,330 in Sep 28 – Oct 4 against 2,290 in Sep 21 – Sep 27, up 40 (1.7%).",
    );
    expect(answer).toContain("This change is within normal variation.");
    expectChecked(answer, facts);
  });

  it("writes a low-volume revenue answer with money", () => {
    const result = evidenceFor({
      metric: "revenue",
      currentTotals: { sessions: 2_700, revenue: 1_650.5, transactions: 6 },
      previousTotals: { sessions: 2_290, revenue: 1_250.25, transactions: 5 },
    });
    expect(result.significance).toBe("low_volume");
    const { answer, facts } = answerOf(result, "TRY");
    expect(
      answer.startsWith(
        "Revenue was 1,650.50 TRY in Sep 28 – Oct 4 against 1,250.25 TRY in Sep 21 – Sep 27, up 400.25 TRY (32%).",
      ),
    ).toBe(true);
    expect(answer).toContain(
      "There is too little data to call this change significant.",
    );
    expect(answer).toContain("revenue per visit");
    expectChecked(answer, facts);
  });

  it("mentions suspect days, holidays and the key events switch", () => {
    const result = evidenceFor({
      metric: "keyEvents",
      currentTotals: { sessions: 2_700, keyEvents: 20 },
      previousTotals: { sessions: 2_290, keyEvents: 10 },
      suspectDays: ["2026-09-30", "2026-10-01"],
      holidays: ["2026-09-23"],
    });
    const { answer, facts } = answerOf(result);
    expect(answer).toContain("2 days in this period had a tracking problem.");
    expect(answer).toContain("This period includes 1 public holiday.");
    expect(answer).toContain(
      "There were too few key events to compare, so this looks at visits.",
    );
    expectChecked(answer, facts);
  });

  it("adds years for a yoy comparison and for ranges across years", () => {
    const yoy = evidenceFor({
      comparison: "yoy",
      previous: ["2025-09-29", "2025-10-05"],
    });
    const yoyAnswer = answerOf(yoy);
    expect(yoyAnswer.answer).toContain(
      "in Sep 28 – Oct 4, 2026 against 90 in Sep 29 – Oct 5, 2025",
    );
    expectChecked(yoyAnswer.answer, yoyAnswer.facts);

    const across = evidenceFor({
      current: ["2026-01-04", "2026-01-10"],
      previous: ["2025-12-28", "2026-01-03"],
    });
    const acrossAnswer = answerOf(across);
    expect(acrossAnswer.answer).toContain(
      "in Jan 4 – Jan 10, 2026 against 90 in Dec 28, 2025 – Jan 3, 2026",
    );
    expectChecked(acrossAnswer.answer, acrossAnswer.facts);
  });

  it("writes 'against none' when changePct is null", () => {
    const result = evidenceFor({
      metric: "sessions",
      previousTotals: { sessions: 0 },
      previousChannels: [],
    });
    expect(result.evidence.changePct).toBeNull();
    const { answer, facts } = answerOf(result);
    expect(
      answer.startsWith(
        "Visits were 2,700 in Sep 28 – Oct 4 against none in Sep 21 – Sep 27.",
      ),
    ).toBe(true);
    expectChecked(answer, facts);
  });

  it("writes per-day values for MoM", () => {
    const result = evidenceFor({
      metric: "sessions",
      comparison: "mom",
      perDay: true,
      current: ["2026-09-01", "2026-09-30"],
      previous: ["2026-08-01", "2026-08-31"],
      currentTotals: { sessions: 3_600 },
      previousTotals: { sessions: 3_100 },
    });
    const { answer, facts } = answerOf(result);
    expect(
      answer.startsWith(
        "Visits were 120 a day in Sep 1 – Sep 30 against 100 a day in Aug 1 – Aug 31, up 20 (20%).",
      ),
    ).toBe(true);
    expectChecked(answer, facts);
  });

  it("mentions the top component label and at most three components", () => {
    const { answer } = answerOf(evidenceFor({}));
    expect(answer).toContain("Organic Search:");
    const labels = [
      "Organic Search:",
      "Direct:",
      "Paid Search:",
      "Referral:",
    ].filter((label) => answer.includes(label));
    expect(labels.length).toBeLessThanOrEqual(3);
  });
});
