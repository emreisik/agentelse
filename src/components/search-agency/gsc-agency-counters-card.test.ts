import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GscAgencyCounters } from "@/lib/seo/agency/types";

import { GscAgencyCountersCard } from "./gsc-agency-counters-card";

// Bu dosyanın kanıtladığı (SC-F9 operatör sayaç kartı): her sayaç etiketiyle
// çizilir; null parçalar hiç çizilmez; yalnız sayı ve etiket vardır.

const full: GscAgencyCounters = {
  extraSites: 11,
  pageGroupRuleSets: 4,
  bigQuery: {
    sources: 6,
    active: 3,
    error: 1,
    budget: 1,
    paused: 1,
    periodsImported7d: 42,
    bytesBilledThisMonth: 12_500_000_000,
  },
  splitTests: {
    open: 5,
    applied: 2,
    evaluating: 3,
    evaluated30d: { worked: 7, didnt: 8, inconclusive: 9 },
    expired30d: 10,
  },
  shares: { active: 13, created7d: 14, viewed7d: 15, brandedWorkspaces: 16 },
};

function render(counters: GscAgencyCounters): string {
  return renderToStaticMarkup(
    createElement(GscAgencyCountersCard, { counters }),
  );
}

describe("GscAgencyCountersCard", () => {
  it("tüm sayaçları etiketiyle çizer", () => {
    const html = render(full);
    const expected: [string, string][] = [
      ["Extra sites", "11"],
      ["Page group rule sets", "4"],
      ["BigQuery sources", "6"],
      ["BigQuery on", "3"],
      ["BigQuery needs attention", "1"],
      ["BigQuery budget used up", "1"],
      ["BigQuery paused", "1"],
      ["Periods imported (7 days)", "42"],
      ["Split tests open", "5"],
      ["Waiting for the change", "2"],
      ["Measuring", "3"],
      ["Worked (30 days)", "7"],
      ["Didn&#x27;t work (30 days)", "8"],
      ["No clear result (30 days)", "9"],
      ["Expired (30 days)", "10"],
      ["Active share links", "13"],
      ["Links created (7 days)", "14"],
      ["Links viewed (7 days)", "15"],
      ["Workspaces with branding", "16"],
    ];
    for (const [label, value] of expected) {
      expect(html).toMatch(
        new RegExp(`${label.replace(/[()]/g, "\\$&")}</p><p[^>]*>${value}</p>`),
      );
    }
    expect(html).toContain("Billed this month");
    expect(html).toContain("12.5 GB");
    expect(html).toContain("Counters only. Customer data is never shown here.");
  });

  it("null parçaları hiç çizmez", () => {
    const html = render({
      extraSites: 0,
      pageGroupRuleSets: 0,
      bigQuery: null,
      splitTests: null,
      shares: null,
    });
    expect(html).toContain("Extra sites");
    expect(html).toContain("Page group rule sets");
    expect(html).not.toContain("BigQuery");
    expect(html).not.toContain("Split tests");
    expect(html).not.toContain("share links");
  });

  it("yalnız kendi parçası dolu olan bölümü çizer", () => {
    const html = render({
      extraSites: 1,
      pageGroupRuleSets: 1,
      bigQuery: null,
      splitTests: null,
      shares: full.shares,
    });
    expect(html).toContain("Active share links");
    expect(html).not.toContain("BigQuery");
    expect(html).not.toContain("Split tests open");
  });
});
