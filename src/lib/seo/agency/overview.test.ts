import { describe, expect, it } from "vitest";

import {
  applyAgencyFilter,
  attentionOf,
  parseAgencyFilter,
  sortAgencyRows,
  summarize,
  type SearchAgencyRow,
} from "./overview";

// Bu dosyanın kanıtladığı: dikkat puanı her kuralda ve tavanda sözleşmedeki
// gibi, süzgeçler doğru satırları seçer, sıralama eşitlikte kararlıdır ve
// toplamlar yalnız verilen satırlardan çıkar.

const TODAY = "2026-10-07";

type AttentionInput = Parameters<typeof attentionOf>[0];

function base(over: Partial<AttentionInput> = {}): AttentionInput {
  return {
    health: "OK",
    critical: 0,
    clicksChangePct: null,
    previousClicks: null,
    finalThrough: "2026-10-05",
    bigQuery: "OFF",
    ...over,
  };
}

function row(over: Partial<SearchAgencyRow> = {}): SearchAgencyRow {
  return {
    linkId: "l1",
    projectId: "p1",
    projectName: "Project",
    siteUrl: "sc-domain:a.com",
    siteLabel: "a.com",
    role: "PRIMARY",
    isMock: false,
    health: "OK",
    healthReason: null,
    finalThrough: "2026-10-05",
    backfillDone: true,
    clicks: 100,
    previousClicks: 100,
    clicksChangePct: 0,
    impressions: 1000,
    position: 5,
    healthScore: 80,
    healthCapped: false,
    openOpportunities: 2,
    critical: 0,
    warn: 0,
    bigQuery: "OFF",
    attention: 0,
    attentionReasons: [],
    ...over,
  };
}

describe("attentionOf", () => {
  it("is zero for a healthy, fresh site", () => {
    expect(attentionOf(base(), TODAY)).toEqual({ score: 0, reasons: [] });
  });

  it("adds 50 for connection problems", () => {
    for (const health of [
      "AUTH",
      "NEEDS_PERMISSION",
      "ACCESS_LOST",
      "GONE",
      "API_DISABLED",
    ]) {
      expect(attentionOf(base({ health }), TODAY)).toEqual({
        score: 50,
        reasons: ["Search Console needs attention"],
      });
    }
  });

  it("adds 30 for DEGRADED and nothing for UNKNOWN", () => {
    expect(attentionOf(base({ health: "DEGRADED" }), TODAY)).toEqual({
      score: 30,
      reasons: ["Search Console updates are failing"],
    });
    expect(attentionOf(base({ health: "UNKNOWN" }), TODAY).score).toBe(0);
  });

  it("adds 15 per critical issue up to 45", () => {
    expect(attentionOf(base({ critical: 1 }), TODAY)).toEqual({
      score: 15,
      reasons: ["1 critical issue"],
    });
    expect(attentionOf(base({ critical: 2 }), TODAY).score).toBe(30);
    expect(attentionOf(base({ critical: 7 }), TODAY)).toEqual({
      score: 45,
      reasons: ["7 critical issues"],
    });
  });

  it("flags a click drop of 20% or more on a site with enough clicks", () => {
    expect(
      attentionOf(base({ clicksChangePct: -20, previousClicks: 100 }), TODAY),
    ).toEqual({ score: 25, reasons: ["Clicks fell 20%"] });
    expect(
      attentionOf(base({ clicksChangePct: -33.4, previousClicks: 500 }), TODAY)
        .reasons,
    ).toEqual(["Clicks fell 33%"]);
    expect(
      attentionOf(base({ clicksChangePct: -19.9, previousClicks: 500 }), TODAY)
        .score,
    ).toBe(0);
    expect(
      attentionOf(base({ clicksChangePct: -60, previousClicks: 99 }), TODAY)
        .score,
    ).toBe(0);
    expect(
      attentionOf(base({ clicksChangePct: -60, previousClicks: null }), TODAY)
        .score,
    ).toBe(0);
  });

  it("flags data older than 5 days", () => {
    expect(attentionOf(base({ finalThrough: "2026-10-02" }), TODAY).score).toBe(0);
    expect(attentionOf(base({ finalThrough: "2026-10-01" }), TODAY)).toEqual({
      score: 20,
      reasons: ["Data is out of date"],
    });
    expect(attentionOf(base({ finalThrough: null }), TODAY).score).toBe(0);
  });

  it("adds 15 for a BigQuery ERROR only", () => {
    expect(attentionOf(base({ bigQuery: "ERROR" }), TODAY)).toEqual({
      score: 15,
      reasons: ["BigQuery export needs attention"],
    });
    expect(attentionOf(base({ bigQuery: "BUDGET" }), TODAY).score).toBe(0);
  });

  it("sums the rules in a fixed order and caps at 100", () => {
    const result = attentionOf(
      base({
        health: "AUTH",
        critical: 3,
        clicksChangePct: -50,
        previousClicks: 1000,
        finalThrough: "2026-09-01",
        bigQuery: "ERROR",
      }),
      TODAY,
    );
    expect(result.score).toBe(100);
    expect(result.reasons).toEqual([
      "Search Console needs attention",
      "3 critical issues",
      "Clicks fell 50%",
      "Data is out of date",
      "BigQuery export needs attention",
    ]);
  });
});

describe("applyAgencyFilter", () => {
  const rows = [
    row({ linkId: "a", attention: 0 }),
    row({ linkId: "b", attention: 30, role: "SECONDARY" }),
    row({ linkId: "c", attention: 29, bigQuery: "ACTIVE" }),
    row({ linkId: "d", attention: 80, bigQuery: "ERROR" }),
  ];
  const ids = (filter: Parameters<typeof applyAgencyFilter>[1]) =>
    applyAgencyFilter(rows, filter).map((r) => r.linkId);

  it("keeps everything for all", () => {
    expect(ids("all")).toEqual(["a", "b", "c", "d"]);
  });
  it("keeps score 30 and above for attention", () => {
    expect(ids("attention")).toEqual(["b", "d"]);
  });
  it("keeps secondary sites", () => {
    expect(ids("secondary")).toEqual(["b"]);
  });
  it("keeps sites with a BigQuery source", () => {
    expect(ids("bigquery")).toEqual(["c", "d"]);
  });
  it("does not mutate the input", () => {
    const copy = [...rows];
    applyAgencyFilter(rows, "all").reverse();
    expect(rows).toEqual(copy);
  });
});

describe("sortAgencyRows", () => {
  it("sorts by attention, then clicks, then label, then link id", () => {
    const rows = [
      row({ linkId: "1", siteLabel: "b.com", attention: 0, clicks: 10 }),
      row({ linkId: "2", siteLabel: "a.com", attention: 0, clicks: 10 }),
      row({ linkId: "3", siteLabel: "c.com", attention: 0, clicks: 500 }),
      row({ linkId: "4", siteLabel: "d.com", attention: 60, clicks: 1 }),
      row({ linkId: "5", siteLabel: "e.com", attention: 0, clicks: null }),
      row({ linkId: "7", siteLabel: "a.com", attention: 0, clicks: 10 }),
    ];
    expect(sortAgencyRows(rows).map((r) => r.linkId)).toEqual([
      "4",
      "3",
      "2",
      "7",
      "1",
      "5",
    ]);
  });
});

describe("summarize", () => {
  it("totals sites, distinct projects, clicks, attention and critical", () => {
    const totals = summarize([
      row({ projectId: "p1", clicks: 10, previousClicks: 5, attention: 50, critical: 2 }),
      row({ projectId: "p1", clicks: null, previousClicks: null, attention: 0 }),
      row({ projectId: "p2", clicks: 30, previousClicks: 40, attention: 30, critical: 1 }),
    ]);
    expect(totals).toEqual({
      sites: 3,
      projects: 2,
      clicks: 40,
      previousClicks: 45,
      needAttention: 2,
      critical: 3,
    });
  });

  it("is all zero for no rows", () => {
    expect(summarize([])).toEqual({
      sites: 0,
      projects: 0,
      clicks: 0,
      previousClicks: 0,
      needAttention: 0,
      critical: 0,
    });
  });
});

describe("parseAgencyFilter", () => {
  it("accepts the four filters and falls back to all", () => {
    for (const filter of ["all", "attention", "secondary", "bigquery"]) {
      expect(parseAgencyFilter(filter)).toBe(filter);
    }
    expect(parseAgencyFilter("nope")).toBe("all");
    expect(parseAgencyFilter(undefined)).toBe("all");
    expect(parseAgencyFilter(["attention"])).toBe("all");
    expect(parseAgencyFilter(5)).toBe("all");
  });
});
