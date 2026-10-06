import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SearchOverview } from "@/server/seo/overview";

const { SearchOverviewView } = await import("./search-overview-card");

// Bu dosyanın kanıtladığı: Brand sekmesindeki Search kartı yüklenirken ve
// veri yokken hiçbir şey çizmez; veri varken marka dışı (ya da tüm)
// tıklamaları, önceki 28 güne göre değişimi, kesin gün etiketini ve yalnız
// sayfa açıkken "Open" bağlantısını gösterir.

const render = (state: Parameters<typeof SearchOverviewView>[0]["state"]) =>
  renderToStaticMarkup(
    createElement(SearchOverviewView, { projectId: "proj-1", state }),
  );
const done = (overview: SearchOverview) => render({ status: "done", overview });

const OK: Extract<SearchOverview, { ok: true }> = {
  ok: true,
  from: "2026-09-06",
  to: "2026-10-03",
  clicks: 1_500,
  previousClicks: 1_200,
  nonBrandClicks: 1_100,
  previousNonBrandClicks: 1_000,
  trend: Array.from({ length: 28 }, (_, index) => 30 + index),
  health: "OK",
  finalThrough: "2026-10-03",
  pageHref: "/projects/proj-1/arama",
  isMock: false,
};

describe("SearchOverviewView", () => {
  it("renders nothing while loading", () => {
    expect(render({ status: "loading" })).toBe("");
  });

  it("renders nothing when the warehouse is off or not synced yet", () => {
    expect(done({ ok: false, reason: "off" })).toBe("");
    expect(done({ ok: false, reason: "not_synced" })).toBe("");
  });

  it("shows non-brand clicks for 28 days with the change and the final-data line", () => {
    const html = done(OK);
    expect(html).toContain('data-card="search-overview"');
    expect(html).toContain("Search");
    expect(html).toContain("1,100");
    expect(html).toContain("Non-brand clicks");
    expect(html).toContain("28 days");
    expect(html).toContain("▲ 10.0% vs previous 28 days");
    expect(html).toContain("Final data through Oct 3 · Pacific Time");
    expect(html).toContain('href="/projects/proj-1/arama"');
    expect(html).toContain("<polyline");
    expect(html).not.toContain("needs attention");
  });

  it("falls back to all clicks when there is no brand split", () => {
    const html = done({
      ...OK,
      nonBrandClicks: null,
      previousNonBrandClicks: null,
    });
    expect(html).toContain("1,500");
    expect(html).toContain(">Clicks, 28 days");
    expect(html).not.toContain("Non-brand");
    expect(html).toContain("▲ 25.0% vs previous 28 days");
  });

  it("has no Open link without a page, and a health dot when the link is unhealthy", () => {
    const html = done({
      ...OK,
      pageHref: null,
      health: "AUTH",
      previousNonBrandClicks: null,
    });
    expect(html).not.toContain("Open");
    expect(html).not.toContain("href=");
    expect(html).toContain("Search Console needs attention");
    expect(html).toContain("No comparison");
  });
});
