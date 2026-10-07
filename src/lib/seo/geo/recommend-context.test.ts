import { describe, expect, it } from "vitest";

import { GEO_CHECKS } from "./catalog";
import { geoRecommendContext } from "./recommend-context";
import type { GeoAuditResult, GeoCheckResult } from "./types";

// Bu dosyanın kanıtladığı (SC-F8): modele giden bağlam yalnız WARN/INFO
// kontrollerin sabit başlığını ve sayı/boolean olgularını taşır; sitenin kendi
// metni, GEO3 ve ACK girmez; en çok 8 kontrol, WARN önce.

function result(checks: GeoCheckResult[]): GeoAuditResult {
  return {
    v: 1,
    score: 50,
    checks,
    crawlers: [],
    llms: { state: "missing", bytes: 0, hasTitle: false, links: 0, sections: 0 },
    org: { present: true, types: [], name: "Secret Brand Ltd", sameAs: [], hasLogo: false },
    pages: {
      audited: 0,
      indexable: 0,
      withFaqSchema: 0,
      withQuestionHeadings: 0,
      longWithoutHeadings: 0,
      snippetBlocked: 0,
      renderRisk: 0,
    },
    auditedAt: "2026-10-07T00:00:00.000Z",
  };
}

describe("geoRecommendContext", () => {
  it("keeps only WARN and INFO checks, never GEO3 or ACK", () => {
    const context = geoRecommendContext(
      result([
        { id: "GEO1", status: "INFO", facts: { state: "missing" } },
        { id: "GEO2", status: "ACK", facts: {} },
        { id: "GEO3", status: "INFO", facts: { blockedCount: 1 } },
        { id: "GEO4", status: "PASS", facts: {} },
        { id: "GEO5", status: "WARN", facts: {} },
        { id: "GEO6", status: "NA", facts: {} },
      ]),
    );
    expect(context.checks.map((check) => check.id)).toEqual(["GEO5", "GEO1"]);
  });

  it("carries fixed titles and only numbers and booleans", () => {
    const context = geoRecommendContext(
      result([
        {
          id: "GEO2",
          status: "WARN",
          facts: {
            blocked: ["PerplexityBot", "https://secret.test"],
            blockedCount: 2,
            allowed: 3,
            flag: true,
            text: "Secret Brand Ltd",
            nothing: null,
          },
        },
      ]),
    );
    expect(context.checks).toEqual([
      {
        id: "GEO2",
        title: GEO_CHECKS.GEO2.title,
        status: "WARN",
        facts: { blockedCount: 2, allowed: 3, flag: true },
      },
    ]);
    const json = JSON.stringify(context);
    expect(json).not.toContain("Secret");
    expect(json).not.toContain("secret.test");
  });

  it("puts WARN first, then heavier checks, and caps at eight", () => {
    const checks: GeoCheckResult[] = [
      { id: "GEO1", status: "INFO", facts: {} },
      { id: "GEO4", status: "WARN", facts: {} },
      { id: "GEO8", status: "WARN", facts: {} },
      { id: "GEO7", status: "INFO", facts: {} },
      { id: "GEO2", status: "WARN", facts: {} },
      { id: "GEO5", status: "WARN", facts: {} },
      { id: "GEO6", status: "WARN", facts: {} },
      { id: "GEO9", status: "WARN", facts: {} },
      { id: "GEO10", status: "WARN", facts: {} },
      { id: "GEO11", status: "INFO", facts: {} },
    ];
    const ids = geoRecommendContext(result(checks)).checks.map((check) => check.id);
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe("GEO2");
    expect(ids.slice(0, 7)).toEqual(["GEO2", "GEO8", "GEO5", "GEO4", "GEO6", "GEO9", "GEO10"]);
  });
});
