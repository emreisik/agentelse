import { describe, expect, it } from "vitest";

import {
  buildReportMarkdown,
  buildReportPlainText,
  buildReportPrintHtml,
  reportFileName,
} from "./export";
import { summaryFactsOf } from "./facts";
import type { ReportData } from "./report";

const report: ReportData = {
  period: 90,
  builtAt: "2026-10-05T11:32:00.000Z",
  sections: [
    {
      source: "instagram",
      ok: true,
      account: "@biduniq",
      days: 30,
      currency: null,
      metrics: [
        { key: "ig.reach", value: 12345 },
        { key: "ig.followers", value: 980 },
      ],
      results: [],
      campaigns: [],
      queries: [],
    },
    {
      source: "metaAds",
      ok: true,
      account: "Biduniq Ads",
      days: 90,
      currency: "TRY",
      metrics: [
        { key: "ads.spend", value: 1234.5 },
        { key: "ads.ctr", value: 1.234 },
      ],
      results: [{ label: "Leads", count: 42, costPerResult: 29.39 }],
      campaigns: [
        {
          name: "Spring | *sale*",
          spend: 800,
          resultLabel: "Leads",
          results: 30,
          costPerResult: 26.67,
        },
      ],
      queries: [],
    },
    {
      source: "searchConsole",
      ok: true,
      account: "biduniq.com",
      days: 90,
      currency: null,
      metrics: [{ key: "sc.position", value: 4.25 }],
      results: [],
      campaigns: [],
      queries: [
        {
          query: "<script>alert(1)</script>",
          clicks: 12,
          impressions: 340,
          ctr: 3.53,
          position: 2.1,
        },
      ],
    },
    { source: "ga4", ok: false, reason: "expired" },
  ],
  summary: {
    headline: "Leads cost 29.39 TRY each.",
    highlights: ["Reach hit 12,345."],
    watchouts: ["CTR is 1.23%."],
    nextSteps: ["Reconnect Google Analytics."],
  },
  summaryNote: null,
};

describe("buildReportMarkdown", () => {
  const md = buildReportMarkdown(report, {
    brand: "Biduniq",
    timeZone: "Europe/Istanbul",
  });

  it("titles the report and says its period and build time", () => {
    expect(md.startsWith("# Biduniq · Analytics report\n")).toBe(true);
    expect(md).toContain("Last 90 days · Built 5 Oct 2026, 14:32");
  });

  it("puts the summary first, then one section per source", () => {
    expect(md).toContain("**Leads cost 29.39 TRY each.**");
    expect(md).toContain("- Reach hit 12,345.");
    expect(md.indexOf("## Summary")).toBeLessThan(md.indexOf("## Instagram"));
    expect(md).toContain("## Instagram · @biduniq");
    expect(md).toContain("| Reach | 12,345 |");
    expect(md).toContain("| Followers (now) | 980 |");
    // Instagram's own window is said, not hidden.
    expect(md).toContain("Last 30 days");
    expect(md).toContain("Instagram gives at most 30 days at a time.");
    expect(md).toContain("| Spend | 1,234.50 TRY |");
    expect(md).toContain("| CTR | 1.23% |");
    expect(md).toContain("| Leads | 42 | 29.39 TRY |");
  });

  it("says why a source has no numbers", () => {
    expect(md).toContain("## Google Analytics");
    expect(md).toContain(
      "Couldn't be read. The connection expired. Reconnect it.",
    );
  });

  it("makes people's text inert (no table break, emphasis or HTML)", () => {
    expect(md).toContain("Spring \\| \\*sale\\*");
    expect(md).toContain("\\<script\\>alert(1)\\</script\\>");
    expect(md).not.toContain("<script>");
  });

  it("names the file after the build day", () => {
    expect(reportFileName(report)).toBe("analytics-report-2026-10-05.md");
  });
});

describe("number formats", () => {
  it("keeps full numbers in exports and compacts big ones only on tiles", async () => {
    const { formatMetric } = await import("./format");
    expect(formatMetric("money", 1_234_567.891, "TRY")).toBe("1,234,567.89 TRY");
    expect(formatMetric("money", 1_234_567.891, "TRY", { compact: true })).toBe(
      "1.2M TRY",
    );
    expect(formatMetric("money", 400, "TRY", { compact: true })).toBe("400 TRY");
    expect(formatMetric("count", 2_500_000, null, { compact: true })).toBe("2.5M");
    expect(formatMetric("count", 999_999, null, { compact: true })).toBe("999,999");
    expect(formatMetric("duration", 95.4, null)).toBe("1m 35s");
    expect(formatMetric("percent", 62.5, null)).toBe("62.5%");
    expect(formatMetric("position", 4.25, null)).toBe("4.3");
  });
});

describe("buildReportPlainText", () => {
  it("is the summary plus one line of key numbers per source", () => {
    const text = buildReportPlainText(report);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "Analytics report",
      "Last 90 days · Built 5 Oct 2026, 11:32",
      "",
      "Leads cost 29.39 TRY each.",
    ]);
    expect(text).toContain("What went well\n- Reach hit 12,345.");
    expect(text).toContain(
      "Meta Ads · Biduniq Ads (Last 90 days): Spend 1,234.50 TRY · CTR 1.23%",
    );
    expect(text).toContain(
      "Google Analytics: Couldn't be read. The connection expired. Reconnect it.",
    );
  });

  it("says why there is no summary when there is none", () => {
    const text = buildReportPlainText({
      ...report,
      summary: null,
      summaryNote: "The AI summary isn't available right now.",
    });
    expect(text).toContain("The AI summary isn't available right now.");
  });
});

describe("buildReportPrintHtml", () => {
  it("is a standalone page with every text escaped", () => {
    const html = buildReportPrintHtml(report, { brand: "A&B <Co>" });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(
      "<title>A&amp;B &lt;Co&gt; · Analytics report</title>",
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("@page");
  });
});

describe("summaryFactsOf", () => {
  it("gives the model the numbers as shown, and nothing about failed sources", () => {
    const facts = summaryFactsOf(report);
    expect(facts.period).toBe("Last 90 days");
    expect(facts.sections.map((section) => section.source)).toEqual([
      "Instagram",
      "Meta Ads",
      "Search Console",
    ]);
    expect(facts.sections[0]).toEqual({
      source: "Instagram",
      period: "Last 30 days",
      metrics: [
        { name: "Reach", value: "12,345" },
        { name: "Followers (now)", value: "980" },
      ],
    });
    // No account, project or brand reaches the model.
    expect(JSON.stringify(facts)).not.toMatch(/biduniq/i);
  });
});

describe("Google Analytics lists in the exports", () => {
  const ga4 = {
    source: "ga4" as const,
    ok: true as const,
    account: null,
    days: 90,
    currency: null,
    metrics: [{ key: "ga.sessions" as const, value: 1200 }],
    results: [],
    campaigns: [],
    queries: [],
  };
  const withLists: ReportData = {
    ...report,
    sections: [
      ...report.sections.slice(0, 3),
      {
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
            page: "/pricing|<b>",
            sessions: 1234,
            engagementRate: 58.25,
            keyEvents: 3,
          },
        ],
        keyEvents: [{ name: "generate_lead", count: 15 }],
      },
    ],
  };
  const without: ReportData = {
    ...report,
    sections: [...report.sections.slice(0, 3), ga4],
  };

  it("adds the three tables to Markdown, with — for an unknown rate", () => {
    const md = buildReportMarkdown(withLists);
    expect(md).toContain("### Channels");
    expect(md).toContain(
      "| Channel | Sessions | Share | Engaged | Key events |",
    );
    expect(md).toContain("| Organic Search | 540 | 45% | 62.5% | 12 |");
    expect(md).toContain("| Email | 0 | — | — | 0 |");
    expect(md).toContain("### Top landing pages");
    expect(md).toContain("| Page | Sessions | Engaged | Key events |");
    expect(md).toContain("| /pricing\\|\\<b\\> | 1,234 | 58.25% | 3 |");
    expect(md).toContain("### Key events");
    expect(md).toContain("| Event | Key events |");
    expect(md).toContain("| generate\\_lead | 15 |");
  });

  it("adds them to the print view, escaped", () => {
    const html = buildReportPrintHtml(withLists);
    expect(html).toContain("<h3>Channels</h3>");
    expect(html).toContain("<h3>Top landing pages</h3>");
    expect(html).toContain("<h3>Key events</h3>");
    expect(html).toContain("<td>/pricing|&lt;b&gt;</td>");
    expect(html).toContain('<td class="num">—</td>');
    expect(html).not.toContain("/pricing|<b>");
  });

  it("keeps the plain text to the summary and key numbers", () => {
    // Copy summary never carried tables (searches neither): the lists add
    // nothing to it.
    expect(buildReportPlainText(withLists)).toBe(
      buildReportPlainText(without),
    );
  });

  it("is unchanged without the lists", () => {
    const md = buildReportMarkdown(without);
    expect(md).not.toContain("### Channels");
    expect(md).not.toContain("### Top landing pages");
    expect(md).not.toContain("### Key events");
    const html = buildReportPrintHtml(without);
    expect(html).not.toContain("<h3>Channels</h3>");
    // A stored report read back without the lists exports byte for byte the
    // same as before.
    expect(buildReportMarkdown(JSON.parse(JSON.stringify(without)))).toBe(md);
  });
});
