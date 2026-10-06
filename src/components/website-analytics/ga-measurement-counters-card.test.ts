import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GaMeasurementCounters } from "@/lib/website-analytics/health/view-types";

import { GaMeasurementCountersCard } from "./ga-measurement-counters-card";

// Bu dosyanın kanıtladığı (GA-F3, /health): kart yalnız sayaçları gösterir;
// mülk kimliği hiçbir yoldan karta girmez.

const PROPERTY_ID = "987654321";

const counters: GaMeasurementCounters = {
  linksChecked: 7,
  linksDue: 2,
  checksFailing: 3,
  checksWarning: 11,
  checksUnknown: 5,
  alertsCritical: 1,
  alertsWarn: 4,
  scoreBuckets: { good: 3, fair: 2, poor: 1, none: 6 },
  lastRunMinutesAgo: 8,
};

const render = (value: GaMeasurementCounters) =>
  renderToStaticMarkup(
    createElement(GaMeasurementCountersCard, { counters: value }),
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");

describe("GaMeasurementCountersCard", () => {
  it("shows every counter", () => {
    const html = text(render(counters));
    expect(html).toContain("Google Analytics measurement checks");
    expect(html).toContain("Properties checked 7");
    expect(html).toContain("Due for a check 2");
    expect(html).toContain("Checks failing 3");
    expect(html).toContain("Checks warning 11");
    expect(html).toContain("Couldn't check 5");
    expect(html).toContain("Open critical alerts 1");
    expect(html).toContain("Open warnings 4");
    expect(html).toContain("Scores ≥80 3");
    expect(html).toContain("Scores 50–79 2");
    expect(html).toContain("Scores <50 1");
    expect(html).toContain("No score yet 6");
    expect(html).toContain("Last run 8 min ago");
    expect(html).toContain("Counters only.");
  });

  it("renders before the first run", () => {
    const html = text(
      render({
        ...counters,
        linksChecked: 0,
        lastRunMinutesAgo: null,
      }),
    );
    expect(html).toContain("Properties checked 0");
    expect(html).toContain("No measurement check has run yet");
  });

  it("never shows a property id", () => {
    expect(render(counters)).not.toContain(PROPERTY_ID);
    // Kart kimlik alanı almaz; sayaçlara sızmış bir değer bile görünmez.
    const leaked = {
      ...counters,
      propertyId: PROPERTY_ID,
    } as GaMeasurementCounters;
    expect(render(leaked)).not.toContain(PROPERTY_ID);
  });
});
