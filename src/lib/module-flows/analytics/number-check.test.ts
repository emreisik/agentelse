import { describe, expect, it } from "vitest";

import { summaryFactsOf } from "./facts";
import {
  allowedNumbersOf,
  checkSummaryNumbers,
  isSupportedToken,
  keepSupportedSentences,
  readingsOf,
} from "./number-check";

const DATA = {
  period: "Last 28 days",
  sections: [
    {
      source: "Meta Ads",
      metrics: [
        { name: "Spend", value: "1,234.56 TRY" },
        { name: "Impressions", value: "45,678" },
        { name: "CTR", value: "2.35%" },
        { name: "Avg. session", value: "1m 35s" },
      ],
      topSearches: [{ query: "iphone 15 case", position: "4.2" }],
    },
  ],
};

describe("readingsOf", () => {
  it("reads a number the way English and Turkish write it", () => {
    expect(readingsOf("12,345")).toEqual(
      expect.arrayContaining([12345, 12.345]),
    );
    expect(readingsOf("12.345")).toEqual(
      expect.arrayContaining([12345, 12.345]),
    );
    expect(readingsOf("1.234,56")).toEqual([1234.56]);
    expect(readingsOf("1,234.56")).toEqual([1234.56]);
    expect(readingsOf("2,35")).toEqual([2.35]);
    // No language writes a date as a number.
    expect(readingsOf("05.10.2026")).toEqual([]);
  });
});

describe("the number check", () => {
  const allowed = allowedNumbersOf(DATA);

  it("collects every number of the data, strings included", () => {
    expect(allowed).toEqual(
      expect.arrayContaining([28, 1234.56, 45678, 2.35, 1, 35, 15, 4.2]),
    );
  });

  it("accepts the data's numbers as written, translated or rounded", () => {
    for (const token of [
      "1,234.56",
      "1.234,56",
      "45,678",
      "45.7",
      "2,35",
      "4",
      "28",
    ]) {
      expect(isSupportedToken(token, allowed), token).toBe(true);
    }
    // "45.7K" and "1.2K": thousands.
    expect(isSupportedToken("45.7", allowed)).toBe(true);
    expect(isSupportedToken("1.2", allowed)).toBe(true);
  });

  it("refuses numbers the data does not hold", () => {
    for (const token of ["38", "2026", "500", "17.5"]) {
      expect(isSupportedToken(token, allowed), token).toBe(false);
    }
  });

  it("drops only the sentence that names an invented number", () => {
    expect(
      keepSupportedSentences(
        "Spend reached 1,234.56 TRY. Reach grew 38% on the month. CTR held at 2.35%.",
        allowed,
      ),
    ).toBe("Spend reached 1,234.56 TRY. CTR held at 2.35%.");
    expect(keepSupportedSentences("Keep posting Reels.", allowed)).toBe(
      "Keep posting Reels.",
    );
  });

  it("allows a channel share from the facts and drops an invented one", () => {
    const facts = summaryFactsOf({
      period: 28,
      builtAt: "2026-10-05T12:00:00.000Z",
      sections: [
        {
          source: "ga4",
          ok: true,
          account: null,
          days: 28,
          currency: null,
          metrics: [{ key: "ga.sessions", value: 1200 }],
          results: [],
          campaigns: [],
          queries: [],
          channels: [
            {
              channel: "Organic Search",
              sessions: 540,
              share: 45,
              engagementRate: 62.5,
              keyEvents: 12,
            },
          ],
          keyEvents: [{ name: "generate_lead", count: 15 }],
        },
      ],
      summary: null,
      summaryNote: null,
    });
    const gaAllowed = allowedNumbersOf(facts);
    expect(
      keepSupportedSentences(
        "Organic Search brought 45% of sessions. Paid Search brought 73% of sessions. Leads hit 15.",
        gaAllowed,
      ),
    ).toBe("Organic Search brought 45% of sessions. Leads hit 15.");
  });

  it("returns the summary without unsupported sentences, or null when none is left", () => {
    expect(
      checkSummaryNumbers(
        {
          headline: "Reach doubled to 90,000.",
          highlights: ["CTR was 2.35%.", "Up 500 followers."],
          watchouts: [],
          nextSteps: ["Post 3 times a week.", "Test a new audience."],
        },
        allowed,
      ),
    ).toEqual({
      headline: "",
      highlights: ["CTR was 2.35%."],
      watchouts: [],
      nextSteps: ["Test a new audience."],
    });
    expect(
      checkSummaryNumbers(
        {
          headline: "Spend was 9,999 TRY.",
          highlights: [],
          watchouts: [],
          nextSteps: [],
        },
        allowed,
      ),
    ).toBeNull();
  });
});
