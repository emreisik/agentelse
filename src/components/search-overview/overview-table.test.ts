import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SearchAgencyRow } from "@/lib/seo/agency/overview";

const { SearchOverviewTable } = await import("./overview-table");

// Bu dosyanın kanıtladığı: tablo her site için proje bağlantısını (?site=),
// durum noktasını, tıklama değişimini, rozetleri ve boş alanlar için çizgiyi
// gösterir; ikincil sitelerde motor alanları çizgidir; liste boşsa satır
// yerine ipucu çıkar.

const render = (rows: SearchAgencyRow[]) =>
  renderToStaticMarkup(createElement(SearchOverviewTable, { rows }));

function row(over: Partial<SearchAgencyRow> = {}): SearchAgencyRow {
  return {
    linkId: "l1",
    projectId: "p1",
    projectName: "Acme Store",
    siteUrl: "sc-domain:acme.com",
    siteLabel: "acme.com",
    role: "PRIMARY",
    isMock: false,
    health: "OK",
    healthReason: null,
    finalThrough: "2026-10-05",
    backfillDone: true,
    clicks: 12_345,
    previousClicks: 10_000,
    clicksChangePct: 23.5,
    impressions: 456_789,
    position: 7.2,
    healthScore: 81,
    healthCapped: false,
    openOpportunities: 6,
    critical: 0,
    warn: 0,
    bigQuery: "OFF",
    attention: 0,
    attentionReasons: [],
    ...over,
  };
}

describe("SearchOverviewTable", () => {
  it("shows the empty hint and no table for an empty list", () => {
    const html = render([]);
    expect(html).toContain("No sites match this filter.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<tr");
  });

  it("renders one row per site with a link to the project's Search page", () => {
    const html = render([row(), row({ linkId: "l2", projectId: "p2" })]);
    expect(html.match(/data-row=/g)).toHaveLength(2);
    expect(html).toContain('href="/projects/p1/arama?site=l1"');
    expect(html).toContain('href="/projects/p2/arama?site=l2"');
    expect(html).toContain("acme.com");
    expect(html).toContain("Acme Store");
  });

  it("formats numbers and shows the click change", () => {
    const html = render([row()]);
    expect(html).toContain("12,345");
    expect(html).toContain("456,789");
    expect(html).toContain("▲ 23.5%");
    expect(html).toContain("81");
    expect(html).toContain("Oct 5");
    const down = render([row({ clicksChangePct: -12.25 })]);
    expect(down).toContain("▼ 12.3%");
    expect(down).toContain("text-destructive");
  });

  it("renders the column headers", () => {
    const html = render([row()]);
    for (const header of [
      "Site",
      "Status",
      "Clicks 28 d",
      "Impressions",
      "Health score",
      "Opportunities",
      "Alerts",
      "BigQuery",
      "Data through",
    ]) {
      expect(html).toContain(header);
    }
  });

  it("maps health to a status dot tone", () => {
    const tones = (health: string, backfillDone = true) =>
      render([row({ health, backfillDone })]).match(/data-tone="(\w+)"/)?.[1];
    expect(tones("OK")).toBe("ok");
    expect(tones("OK", false)).toBe("idle");
    expect(tones("DEGRADED")).toBe("warn");
    expect(tones("AUTH")).toBe("bad");
    expect(tones("GONE")).toBe("bad");
    expect(tones("UNKNOWN")).toBe("idle");
    expect(render([row({ health: "AUTH" })])).toContain("Reconnect needed");
  });

  it("shows attention reasons under the status, at most two", () => {
    const html = render([
      row({
        attention: 90,
        attentionReasons: ["First reason", "Second reason", "Third reason"],
      }),
    ]);
    expect(html).toContain("First reason");
    expect(html).toContain("Second reason");
    expect(html).not.toContain("Third reason");
  });

  it("badges secondary and sample sites", () => {
    const html = render([row({ role: "SECONDARY", isMock: true })]);
    expect(html).toContain("Secondary");
    expect(html).toContain("Sample");
    const plain = render([row()]);
    expect(plain).not.toContain("Secondary");
    expect(plain).not.toContain("Sample");
  });

  it("shows dashes for fields a secondary site does not have", () => {
    const html = render([
      row({
        role: "SECONDARY",
        healthScore: null,
        openOpportunities: null,
        clicks: null,
        impressions: null,
        finalThrough: null,
      }),
    ]);
    expect(html.match(/—/g)!.length).toBeGreaterThanOrEqual(7);
    expect(html).not.toContain("None");
  });

  it("shows alert counts for a primary site and None when clean", () => {
    const withAlerts = render([row({ critical: 2, warn: 3 })]);
    expect(withAlerts).toContain("2 critical");
    expect(withAlerts).toContain("3 to check");
    expect(render([row()])).toContain("None");
  });

  it("shows the BigQuery badge only when a source exists", () => {
    expect(render([row({ bigQuery: "ACTIVE" })])).toContain("On");
    expect(render([row({ bigQuery: "ERROR" })])).toContain("Needs attention");
    expect(render([row({ bigQuery: "BUDGET" })])).toContain(
      "Monthly budget used",
    );
  });

  it("marks a capped health score", () => {
    expect(render([row({ healthScore: 40, healthCapped: true })])).toContain(
      "(capped)",
    );
  });
});
