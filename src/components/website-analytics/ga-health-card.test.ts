import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GaHealthCounters } from "@/lib/website-analytics/health-counters";

import { GaHealthCard } from "./ga-health-card";

// Bu dosyanın kanıtladığı (GA-F2 bölüm 2, /health): kart yalnız sayaçları
// gösterir; hata sınıfları tek satırda, Limited Use dipnotu her zaman var;
// mülk kimliği gibi müşteri verisi hiçbir yoldan karta girmez.

const PROPERTY_ID = "987654321";

const counters: GaHealthCounters = {
  links: {
    total: 7,
    mock: 1,
    byHealth: {
      OK: 4,
      AUTH: 1,
      NEEDS_PERMISSION: 1,
      GONE: 1,
      // Sağlık anahtarına sızmış bir kimlik bile gösterilmemeli.
      [PROPERTY_ID]: 0,
    },
  },
  sync: {
    failing: 2,
    rateLimited: 1,
    neverSynced: 0,
    lagOver2Days: 1,
    backfillPending: 1,
    addonsPending: 2,
    heartbeatMinutesAgo: 3,
  },
  quota: { maxDailyShare: 42, overHalfDaily: 0, overHalfHourly: 1 },
  api: {
    windowHours: 24,
    calls: 318,
    errors: { SERVER_ERROR: 1, AUTH: 2, RATE_LIMIT: 0 },
  },
  catalog: {
    droppedReports: 2,
    linksWithDeprecated: 1,
    googleAdsEnabled: 1,
    searchConsoleEnabled: 3,
  },
};

const zero: GaHealthCounters = {
  links: { total: 0, mock: 0, byHealth: {} },
  sync: {
    failing: 0,
    rateLimited: 0,
    neverSynced: 0,
    lagOver2Days: 0,
    backfillPending: 0,
    addonsPending: 0,
    heartbeatMinutesAgo: null,
  },
  quota: { maxDailyShare: null, overHalfDaily: 0, overHalfHourly: 0 },
  api: { windowHours: 24, calls: 0, errors: {} },
  catalog: {
    droppedReports: 0,
    linksWithDeprecated: 0,
    googleAdsEnabled: 0,
    searchConsoleEnabled: 0,
  },
};

const render = (value: GaHealthCounters) =>
  renderToString(createElement(GaHealthCard, { counters: value }));

// React metin düğümleri arasına yorum işaretleri koyar; metni düzleştirir.
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

describe("GaHealthCard", () => {
  it("shows the counters, the error classes and the Limited Use footnote", () => {
    const html = text(render(counters));
    expect(html).toContain("Google Analytics");
    expect(html).toContain("Properties 7");
    expect(html).toContain("Healthy 4");
    expect(html).toContain("Need reconnect 2");
    expect(html).toContain("Access lost 1");
    expect(html).toContain("Failing 2");
    expect(html).toContain("Rate-limited 1");
    expect(html).toContain("Data late (>2 days) 1");
    expect(html).toContain("History loading 3");
    expect(html).toContain("Highest daily quota use 42%");
    expect(html).toContain("Over half of hourly quota 1");
    expect(html).toContain("API calls (24 h) 318");
    expect(html).toContain("AUTH 2 · SERVER_ERROR 1");
    expect(html).not.toContain("RATE_LIMIT");
    expect(html).toContain("Reports dropped 2");
    expect(html).toContain("Deprecated fields 1");
    expect(html).toContain("Google Ads reports on 1");
    expect(html).toContain("Search Console reports on 3");
    expect(html).toContain("Last sync heartbeat: 3 min ago");
    expect(html).toContain("Counters only. Customer data is never shown here.");
  });

  it("never shows a property id", () => {
    expect(render(counters)).not.toContain(PROPERTY_ID);
  });

  it("renders with no links", () => {
    const html = text(render(zero));
    expect(html).toContain("Properties 0");
    expect(html).toContain("Highest daily quota use —");
    expect(html).toContain("No API errors");
    expect(html).toContain("No sync heartbeat yet");
    expect(html).toContain("Counters only.");
  });
});
