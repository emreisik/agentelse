import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SeoGeoCounters } from "@/server/seo/geo/counters";

import { GeoCountersCard } from "./geo-counters-card";

// Bu dosyanın kanıtladığı (SC-F8, /health): kart yalnız sayaçları gösterir
// (kontrol başlığına göre uyarı dökümü dahil) ve hiçbir yoldan proje adı,
// adres ya da kurum adı girmez.

const counters: SeoGeoCounters = {
  sites: 9,
  audited30d: 7,
  scoreBuckets: { low: 2, mid: 3, high: 2 },
  warnByCheck: { GEO2: 4, GEO1: 0, GEO9: 1, bogus: 3 },
  llmsPresent: 2,
  trafficLinked: 5,
};

const render = (value: SeoGeoCounters) =>
  renderToStaticMarkup(createElement(GeoCountersCard, { counters: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("GeoCountersCard", () => {
  it("shows every counter", () => {
    const plain = text(render(counters));
    expect(plain).toContain("AI search visibility");
    expect(plain).toContain("Sites 9");
    expect(plain).toContain("Checked (30d) 7");
    expect(plain).toContain("llms.txt present 2");
    expect(plain).toContain("Score under 50 2");
    expect(plain).toContain("Score 50 to 79 3");
    expect(plain).toContain("Score 80 or more 2");
    expect(plain).toContain("Linked to Analytics 5");
    expect(plain).toContain("Counters only.");
  });

  it("breaks needs-attention down by check title, largest first, ignoring unknown ids", () => {
    const plain = text(render(counters));
    expect(plain).toContain("Needs attention by check");
    expect(plain.indexOf("AI search crawlers 4")).toBeGreaterThan(-1);
    expect(plain.indexOf("AI search crawlers 4")).toBeLessThan(plain.indexOf("Snippet controls 1"));
    expect(plain).not.toContain("bogus");
    expect(plain).not.toContain("llms.txt file 0");
  });

  it("omits the breakdown when nothing needs attention", () => {
    const plain = text(render({ ...counters, warnByCheck: {} }));
    expect(plain).not.toContain("Needs attention by check");
  });
});
