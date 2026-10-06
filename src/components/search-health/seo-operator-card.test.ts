import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SeoOperatorCounters } from "@/server/seo/health/operator-counters";

import { SeoOperatorCard } from "./seo-operator-card";

// Bu dosyanın kanıtladığı (SC-F3, /health): kart yalnız sayaçları gösterir;
// proje adı ya da site adresi hiçbir yoldan karta girmez.

const counters: SeoOperatorCounters = {
  sitesTracked: 9,
  inspectionsToday: 142,
  inspectionSitesPaused: 1,
  crawlsRunning: 2,
  crawlsBlocked: 3,
  crawlFailures24h: 4,
  cwvKeyMissing: false,
  updatesLastSync: new Date(Date.now() - 2 * 60 * 60 * 1000),
};

const render = (value: SeoOperatorCounters) =>
  renderToStaticMarkup(createElement(SeoOperatorCard, { counters: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("SeoOperatorCard", () => {
  it("shows every counter and the updates sync", () => {
    const html = render(counters);
    const plain = text(html);
    expect(plain).toContain("Search health (site audit)");
    expect(plain).toContain("Sites tracked 9");
    expect(plain).toContain("URL inspections today 142");
    expect(plain).toContain("Inspections paused 1");
    expect(plain).toContain("Crawls running 2");
    expect(plain).toContain("Crawls blocked 3");
    expect(plain).toContain("Crawl failures (24h) 4");
    expect(plain).toContain("Google updates last synced about 2 hours ago");
    expect(html).toContain('href="/health/search-updates"');
    expect(plain).not.toContain("CrUX key missing");
    expect(plain).toContain("Counters only.");
  });

  it("warns when the CrUX key is missing and before the first sync", () => {
    const plain = text(
      render({ ...counters, cwvKeyMissing: true, updatesLastSync: null }),
    );
    expect(plain).toContain("CrUX key missing");
    expect(plain).toContain("Google updates have not synced yet");
  });

  it("never shows project names or site addresses", () => {
    const leaked = {
      ...counters,
      projectName: "Acme Bakery",
      origin: "https://acme-bakery.example",
    } as SeoOperatorCounters;
    const html = render(leaked);
    expect(html).not.toContain("Acme Bakery");
    expect(html).not.toContain("acme-bakery.example");
    // Görünen metinde adres yok (SVG ad alanı işaretleme içinde kalır).
    expect(text(html)).not.toMatch(/https?:\/\//);
  });
});
