import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { addDays } from "@/lib/seo/dates";
import { resolveSearchPeriod } from "@/lib/seo/periods";
import type { SearchKpi, SearchReport } from "@/server/seo/report";

const { SearchPeriodSelector, SearchReportBody } =
  await import("./search-report-view");

// Bu dosyanın kanıtladığı: Search sayfasının gövdesi marka ayrımı hazırken
// "Non-brand clicks" ile başlayan 6 KPI'yı, ayrım yokken 4 KPI'yı çizer;
// ortalama sıradaki düşüş yeşildir; taze günler "Fresh (may change)" ile
// ayrılır; marka satırları çip taşır; anonim pay ve arşiv notu yalnız
// verildiğinde görünür; ayrım yokken sorgu süzgeci gizlenir; dönem
// bağlantıları sorgu süzgecini korur.

const BASE = "/projects/proj-1/arama";

const kpi = (
  key: SearchKpi["key"],
  label: string,
  value: number | null,
  previous: number | null,
  format: SearchKpi["format"] = "count",
  lowerIsBetter = false,
): SearchKpi => ({ key, label, value, previous, format, lowerIsBetter });

const SIX: SearchKpi[] = [
  kpi("nonBrandClicks", "Non-brand clicks", 1_100, 1_000),
  kpi("brandClicks", "Brand clicks", 400, 500),
  kpi("clicks", "Clicks", 1_500, 1_500),
  kpi("impressions", "Impressions", 40_000, null),
  kpi("ctr", "CTR", 3.75, 3.5, "percent"),
  kpi("position", "Average position", 4.2, 5, "position", true),
];

const trend = Array.from({ length: 28 }, (_, index) => ({
  day: addDays("2026-09-06", index),
  clicks: 50 + index,
  nonBrandClicks: 40 + index,
  fresh: false,
}));

const period = resolveSearchPeriod("28d", "2026-10-03");

const REPORT: SearchReport = {
  link: {
    siteUrl: "sc-domain:example.com",
    siteLabel: "example.com",
    propertyType: "DOMAIN",
    permissionLevel: "siteOwner",
    domainMatch: true,
    health: "OK",
    healthReason: null,
    dataThrough: "2026-10-05",
    finalThrough: "2026-10-03",
    earliest: "2025-06-06",
    googleWindowStart: "2025-06-06",
    backfillDone: true,
    archive: true,
    brandTerms: ["acme"],
    brandSplit: "ready",
    isMock: false,
  },
  period,
  coverage: { days: 28, expected: 28 },
  kpis: SIX,
  trend,
  previousTrend: trend.map((point) => point.clicks - 5),
  queries: {
    rows: [
      {
        label: "acme shoes",
        href: null,
        isBrand: true,
        clicks: 300,
        impressions: 2_000,
        ctr: 15,
        position: 1.2,
      },
      {
        label: "running shoes",
        href: null,
        isBrand: false,
        clicks: 120,
        impressions: 9_000,
        ctr: 1.33,
        position: 7.8,
      },
    ],
    weeks: period.weeks,
    aggregation: "By property",
    truncated: false,
    notes: ["Weekly totals for complete weeks only."],
  },
  pages: {
    rows: [
      {
        label: "www.example.com/shoes",
        href: "https://www.example.com/shoes",
        isBrand: false,
        clicks: 200,
        impressions: 5_000,
        ctr: 4,
        position: 3.1,
      },
    ],
    weeks: period.weeks,
    aggregation: "By page",
    truncated: false,
    notes: [],
  },
  queryFilter: "all",
  anonymousShare: 0.234,
  notes: ["Non-brand clicks include searches Google doesn't show."],
  archiveNote: "Includes history older than the 16 months Google keeps.",
};

const render = (report: SearchReport) =>
  renderToStaticMarkup(createElement(SearchReportBody, { report, base: BASE }));

// Bir KPI kartının markup'ı: data-kpi'den bir sonrakine kadar.
function kpiCard(html: string, key: string): string {
  const start = html.indexOf(`data-kpi="${key}"`);
  const next = html.indexOf("data-kpi=", start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("SearchReportBody", () => {
  it("shows 6 KPI cards, non-brand clicks first, and a lower position in green", () => {
    const html = render(REPORT);
    const keys = [...html.matchAll(/data-kpi="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(keys).toEqual([
      "nonBrandClicks",
      "brandClicks",
      "clicks",
      "impressions",
      "ctr",
      "position",
    ]);
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("sm:grid-cols-3");
    const position = kpiCard(html, "position");
    expect(position).toContain("▼");
    expect(position).toContain("text-emerald-700");
    expect(kpiCard(html, "brandClicks")).toContain("text-rose-700");
    expect(kpiCard(html, "nonBrandClicks")).toContain("text-emerald-700");
    expect(kpiCard(html, "impressions")).toContain("No comparison");
  });

  it("titles the trend with non-brand clicks and marks fresh days", () => {
    const solid = render(REPORT);
    expect(solid).toContain("Non-brand clicks per day");
    expect(solid).not.toContain("Fresh (may change)");

    // Kurucu taze günlere marka ayrımı yazmaz: nonBrandClicks null gelir.
    const freshPoints = [
      { day: "2026-10-04", clicks: 70, nonBrandClicks: null, fresh: true },
      { day: "2026-10-05", clicks: 72, nonBrandClicks: null, fresh: true },
    ];
    const withFresh = render({ ...REPORT, trend: [...trend, ...freshPoints] });
    expect(withFresh).toContain("Non-brand clicks per day");
    expect(withFresh).not.toContain('data-series="fresh"');
    expect(withFresh).toContain("data-fresh-dropped");

    const fresh = render({
      ...REPORT,
      trend: [
        ...trend.map((point) => ({ ...point, nonBrandClicks: null })),
        ...freshPoints,
      ],
    });
    expect(fresh).toContain("Clicks per day");
    expect(fresh).toContain("Fresh (may change)");
    expect(fresh).toContain('data-series="fresh"');
    expect(fresh).toContain("The last 2 days are fresh and may change.");
  });

  it("uses all clicks for the trend title without non-brand values", () => {
    const html = render({
      ...REPORT,
      trend: trend.map((point) => ({ ...point, nonBrandClicks: null })),
    });
    expect(html).toContain("Clicks per day");
    expect(html).not.toContain("Non-brand clicks per day");
  });

  it("puts a Brand chip on brand rows and links pages in a new tab", () => {
    const html = render(REPORT);
    const brandRow = html.slice(
      html.indexOf("acme shoes"),
      html.indexOf("running shoes"),
    );
    expect(brandRow).toContain(">Brand<");
    const plainRow = html.slice(
      html.indexOf("running shoes"),
      html.indexOf("Top pages"),
    );
    expect(plainRow).not.toContain(">Brand<");
    expect(html).toContain('href="https://www.example.com/shoes"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("Sep 7 – Sep 27 · By property");
    expect(html).toContain("Sep 7 – Sep 27 · By page");
    for (const column of ["Clicks", "Impressions", "CTR", "Position"]) {
      expect(html).toContain(`>${column}</th>`);
    }
  });

  it("shows the anonymous share only when it is known", () => {
    expect(render(REPORT)).toContain(
      "23% of clicks come from searches Google doesn&#x27;t show.",
    );
    expect(render({ ...REPORT, anonymousShare: null })).not.toContain(
      "of clicks come from searches",
    );
  });

  it("lists the table notes, the report notes and the archive note", () => {
    const html = render(REPORT);
    expect(html).toContain("Weekly totals for complete weeks only.");
    expect(html).toContain(
      "Non-brand clicks include searches Google doesn&#x27;t show.",
    );
    expect(html).toContain(
      "Includes history older than the 16 months Google keeps.",
    );
    expect(render({ ...REPORT, archiveNote: null })).not.toContain(
      "Includes history older",
    );
  });

  it("shows the brand filter only when brand terms exist, keeping the period", () => {
    const html = render({
      ...REPORT,
      period: resolveSearchPeriod("3m", "2026-10-03"),
    });
    expect(html).toContain('data-filter="queries"');
    expect(html).toContain(`href="${BASE}?period=3m&amp;queries=non-brand"`);
    expect(html).toContain(`href="${BASE}?period=3m&amp;queries=brand"`);
    expect(html).toContain(`href="${BASE}?period=3m"`);

    const none = render({
      ...REPORT,
      link: { ...REPORT.link, brandSplit: "none", brandTerms: [] },
    });
    expect(none).not.toContain('data-filter="queries"');
  });

  it("renders the 4-KPI variant without a brand split", () => {
    const html = render({ ...REPORT, kpis: SIX.slice(2) });
    const keys = [...html.matchAll(/data-kpi="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(keys).toEqual(["clicks", "impressions", "ctr", "position"]);
  });

  it("says when the tables are empty", () => {
    const html = render({
      ...REPORT,
      queries: { ...REPORT.queries, rows: [] },
      pages: { ...REPORT.pages, rows: [] },
    });
    expect(html).toContain("No searches in these weeks yet.");
    expect(html).toContain("No pages in these weeks yet.");
  });
});

describe("SearchPeriodSelector", () => {
  it("keeps the queries filter and leaves ?period off for 28 days", () => {
    const html = renderToStaticMarkup(
      createElement(SearchPeriodSelector, {
        base: BASE,
        value: "28d",
        queryFilter: "brand",
      }),
    );
    expect(html).toContain(`href="${BASE}?queries=brand"`);
    expect(html).toContain(`href="${BASE}?period=7d&amp;queries=brand"`);
    expect(html).toContain(`href="${BASE}?period=12m&amp;queries=brand"`);

    const plain = renderToStaticMarkup(
      createElement(SearchPeriodSelector, {
        base: BASE,
        value: "7d",
        queryFilter: "all",
      }),
    );
    expect(plain).toContain(`href="${BASE}"`);
    expect(plain).toContain(`href="${BASE}?period=7d"`);
  });

  it("keeps ?site= when the base already carries a query (SC-F9)", () => {
    const base = `${BASE}?site=link-2`;
    const html = renderToStaticMarkup(
      createElement(SearchPeriodSelector, {
        base,
        value: "28d",
        queryFilter: "brand",
      }),
    );
    expect(html).toContain(`href="${base}&amp;queries=brand"`);
    expect(html).toContain(`href="${base}&amp;period=7d&amp;queries=brand"`);
    const plain = renderToStaticMarkup(
      createElement(SearchPeriodSelector, {
        base,
        value: "7d",
        queryFilter: "all",
      }),
    );
    expect(plain).toContain(`href="${base}"`);
  });
});
