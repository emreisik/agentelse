import { describe, expect, it } from "vitest";

import { summaryFactsOf } from "./facts";
import type { OkSection, ReportData } from "./report";

// What this suite proves: the Google Analytics lists reach the AI facts only
// when the section has them, written as the report shows them, and a section
// without them gives exactly the facts it gave before the lists existed.

const ga4: OkSection = {
  source: "ga4",
  ok: true,
  account: null,
  days: 28,
  currency: null,
  metrics: [{ key: "ga.sessions", value: 1200 }],
  results: [],
  campaigns: [],
  queries: [],
};

function reportWith(section: OkSection): ReportData {
  return {
    period: 28,
    builtAt: "2026-10-05T12:00:00.000Z",
    sections: [section],
    summary: null,
    summaryNote: null,
  };
}

describe("summaryFactsOf with Google Analytics lists", () => {
  it("is unchanged for a section without lists", () => {
    const facts = summaryFactsOf(reportWith(ga4));
    expect(JSON.stringify(facts)).toBe(
      JSON.stringify({
        period: "Last 28 days",
        sections: [
          {
            source: "Google Analytics",
            period: "Last 28 days",
            metrics: [{ name: "Sessions", value: "1,200" }],
          },
        ],
      }),
    );
  });

  it("carries channels, landing pages and key events as shown", () => {
    const facts = summaryFactsOf(
      reportWith({
        ...ga4,
        channels: [
          {
            channel: "Organic Search",
            sessions: 540,
            share: 45,
            engagementRate: 62.5,
            keyEvents: 12,
          },
          {
            channel: "Email",
            sessions: 0,
            share: null,
            engagementRate: null,
            keyEvents: 0,
          },
        ],
        landingPages: [
          {
            page: "/pricing",
            sessions: 1234,
            engagementRate: 58.25,
            keyEvents: 3,
          },
        ],
        keyEvents: [{ name: "generate_lead", count: 15 }],
      }),
    );
    expect(facts.sections[0]).toEqual({
      source: "Google Analytics",
      period: "Last 28 days",
      metrics: [{ name: "Sessions", value: "1,200" }],
      topChannels: [
        {
          channel: "Organic Search",
          sessions: "540",
          share: "45%",
          engagementRate: "62.5%",
          keyEvents: "12",
        },
        // Unknown rates are left out, never written as zero.
        { channel: "Email", sessions: "0", keyEvents: "0" },
      ],
      topLandingPages: [
        {
          page: "/pricing",
          sessions: "1,234",
          engagementRate: "58.25%",
          keyEvents: "3",
        },
      ],
      keyEvents: [{ name: "generate_lead", count: "15" }],
    });
  });

  it("adds only the lists that are present", () => {
    const facts = summaryFactsOf(
      reportWith({ ...ga4, keyEvents: [{ name: "purchase", count: 2 }] }),
    );
    expect(Object.keys(facts.sections[0]!)).toEqual([
      "source",
      "period",
      "metrics",
      "keyEvents",
    ]);
  });
});
