import { describe, expect, it } from "vitest";

import {
  buildSeoReportMarkdown,
  buildSeoReportPlainText,
  buildSeoReportPrintHtml,
  seoReportFileName,
} from "./export";
import { sampleView } from "./test-support";
import { SEO_REPORT_KINDS, type SeoReportSection, type SeoReportView } from "./types";

function withTableLabel(view: SeoReportView, label: string): SeoReportView {
  const sections: SeoReportSection[] = view.snapshot.sections.map((section) => {
    if (section.type !== "table" || section.table.key !== "winning_pages") {
      return section;
    }
    return {
      ...section,
      table: {
        ...section.table,
        rows: section.table.rows.map((row) => ({ ...row, label })),
      },
    };
  });
  return { ...view, snapshot: { ...view.snapshot, sections } };
}

describe("buildSeoReportMarkdown", () => {
  const markdown = buildSeoReportMarkdown(sampleView("WEEKLY"));

  it("has the title, the period line, the narrative and the notes", () => {
    expect(markdown).toContain("# Weekly SEO report");
    expect(markdown).toContain("Sep 28 – Oct 4 · example.com");
    expect(markdown).toContain("**Non-brand clicks fell while positions slipped.**");
    expect(markdown).toContain("### Highlights");
    expect(markdown).toContain("### Watch outs");
    expect(markdown).toContain("### Next steps");
    expect(markdown).toContain("Pacific Time");
    expect(markdown).toContain(
      "Numbers from Google Search Console, stored by Agentelse. Search Console days (Pacific Time).",
    );
  });

  it("has the KPI table with a change column", () => {
    expect(markdown).toContain(
      "| Metric | Sep 28 – Oct 4 | Previous period | Change | Last year |",
    );
    expect(markdown).toContain("| Non-brand clicks | 840 | 1,200 | −30% | 700 |");
  });

  it("has a block per section", () => {
    expect(markdown).toContain("## Queries that gained clicks");
    expect(markdown).toContain("| Query | Clicks | Change | Impressions | Position |");
    expect(markdown).toContain("## Search health");
    expect(markdown).toContain("## Opportunities");
    expect(markdown).toContain("## Actions and results");
    expect(markdown).toContain("## Google updates and incidents");
  });

  it("prints the diagnosis change as a percent, not a fraction", () => {
    expect(markdown).toContain("(−30%)");
    expect(markdown).not.toContain("−0.3%");
    expect(markdown).toContain("### Check in Search Console");
    expect(markdown).toContain("Manual actions");
  });

  it("escapes a pipe in a query", () => {
    const view = withTableLabel(sampleView("WEEKLY"), "a|b");
    expect(buildSeoReportMarkdown(view)).toContain("a\\|b");
  });

  it("writes the goals table and the forecast for a monthly report", () => {
    const monthly = buildSeoReportMarkdown(sampleView("MONTHLY"));
    expect(monthly).toContain("| Goal | Target | Now | Pace |");
    expect(monthly).toContain("At risk");
    expect(monthly).toContain("About 3,600 (3,060–4,140), trend; directional");
    expect(monthly).toContain("directional");
  });

  it("writes the roadmap lists", () => {
    const roadmap = buildSeoReportMarkdown(sampleView("ROADMAP"));
    expect(roadmap).toContain("## What to do next");
    expect(roadmap).toContain("## Technical to-do list");
    expect(roadmap).toContain("1. ");
  });

  it("shows the narrative note in italics when there is no narrative", () => {
    const view = sampleView("WEEKLY", {
      narrative: null,
      narrativeNote: "AI summary isn't available with sample data.",
    });
    expect(buildSeoReportMarkdown(view)).toContain(
      "_AI summary isn't available with sample data._",
    );
  });

  it("puts the brand in the title", () => {
    expect(
      buildSeoReportMarkdown(sampleView("WEEKLY"), { brand: "Acme" }),
    ).toContain("# Acme · Weekly SEO report");
  });

  it.each(SEO_REPORT_KINDS)("builds the %s sample without a throw", (kind) => {
    expect(buildSeoReportMarkdown(sampleView(kind)).length).toBeGreaterThan(100);
    expect(buildSeoReportPlainText(sampleView(kind)).length).toBeGreaterThan(100);
    expect(buildSeoReportPrintHtml(sampleView(kind)).length).toBeGreaterThan(100);
  });
});

describe("buildSeoReportPlainText", () => {
  const text = buildSeoReportPlainText(sampleView("WEEKLY"));

  it("has no table or Markdown syntax", () => {
    expect(text).not.toContain("|");
    expect(text).not.toMatch(/^#/m);
    expect(text).not.toContain("**");
  });

  it("keeps the content", () => {
    expect(text).toContain("Weekly SEO report");
    expect(text).toContain("Non-brand clicks fell while positions slipped.");
    expect(text).toContain("Non-brand clicks: ");
    expect(text).toContain("840");
    expect(text).toContain("Pacific Time");
  });
});

describe("buildSeoReportPrintHtml", () => {
  it("is a full document with print styles", () => {
    const html = buildSeoReportPrintHtml(sampleView("WEEKLY"));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>Weekly SEO report</title>");
    expect(html).toContain("@media print");
    expect(html).toContain("<table>");
    expect(html).toContain("<footer>");
  });

  it("escapes a script tag in a page path", () => {
    const view = withTableLabel(
      sampleView("WEEKLY"),
      "/<script>alert(1)</script>",
    );
    const html = buildSeoReportPrintHtml(view);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes the brand and the narrative", () => {
    const view = sampleView("WEEKLY", {
      narrative: {
        headline: "<b>Bold</b> claim",
        highlights: [],
        watchouts: [],
        nextSteps: [],
      },
    });
    const html = buildSeoReportPrintHtml(view, { brand: "A & B" });
    expect(html).toContain("A &amp; B");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; claim");
    expect(html).not.toContain("<b>");
  });

  it("prints the diagnosis change as a percent", () => {
    const html = buildSeoReportPrintHtml(sampleView("WEEKLY"));
    expect(html).toContain("−30%");
    expect(html).not.toContain("−0.3%");
  });
});

describe("seoReportFileName", () => {
  it("is search-<kind>-<period>.<ext>", () => {
    expect(seoReportFileName(sampleView("WEEKLY"))).toBe(
      "search-weekly-2026-09-28.md",
    );
    expect(seoReportFileName(sampleView("MONTHLY"), "html")).toBe(
      "search-monthly-2026-09.html",
    );
    expect(seoReportFileName(sampleView("PULSE"), "txt")).toBe(
      "search-pulse-2026-10-05.txt",
    );
    expect(seoReportFileName(sampleView("ROADMAP"))).toBe(
      "search-roadmap-2026-10.md",
    );
  });
});

describe("live finding status", () => {
  it("reads the live status over the snapshot's", () => {
    const view = sampleView("WEEKLY", {
      findingStatus: { finding_1: "ACCEPTED", finding_2: "DISMISSED" },
    });
    const markdown = buildSeoReportMarkdown(view);
    expect(markdown).toContain("ACCEPTED");
    expect(markdown).toContain("DISMISSED");
  });
});
