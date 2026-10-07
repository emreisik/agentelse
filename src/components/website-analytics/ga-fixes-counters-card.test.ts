import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { GaFixCounters } from "@/lib/website-analytics/fixes/view-types";

import { GaFixesCountersCard } from "./ga-fixes-counters-card";

// Bu dosyanın kanıtladığı (GA-F7, /health): kart yalnız sayaçları gösterir;
// kimlik ya da ad hiçbir yoldan karta girmez.

const counters: GaFixCounters = {
  linksWithEditAccess: 4,
  pendingApprovals: 2,
  last30d: {
    proposed: 9,
    verified: 6,
    failed: 3,
    undone: 1,
    rejected: 2,
    expired: 1,
  },
  failedByCode: { google_unavailable: 2, rejected_by_google: 1 },
  watch: { links: 4, lastRunMinutesAgo: 12, errors: 0 },
  outsideAlertsOpen: 5,
  alphaEnabled: true,
};

const render = (value: GaFixCounters) =>
  renderToStaticMarkup(createElement(GaFixesCountersCard, { counters: value }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("GaFixesCountersCard", () => {
  it("shows every counter", () => {
    const html = text(render(counters));
    expect(html).toContain("Google Analytics fixes");
    expect(html).toContain("Properties with editing allowed 4");
    expect(html).toContain("Waiting for approval 2");
    expect(html).toContain("Done and checked (30 days) 6");
    expect(html).toContain("Didn't work (30 days) 3");
    expect(html).toContain("Undone (30 days) 1");
    expect(html).toContain("Open outside-change alerts 5");
    expect(html).toContain("Change watch last ran 12 min ago");
    expect(html).toContain("google_unavailable: 2");
    expect(html).toContain("rejected_by_google: 1");
    expect(html).toContain("Counters only.");
  });

  it("renders before the first run and without failures", () => {
    const html = text(
      render({
        ...counters,
        failedByCode: {},
        watch: { links: 0, lastRunMinutesAgo: null, errors: 0 },
      }),
    );
    expect(html).toContain("The change watch has not run yet");
    expect(html).not.toContain("google_unavailable");
  });

  it("never shows ids or names that leak into the counters", () => {
    const leaked = {
      ...counters,
      propertyId: "987654321",
      propertyName: "Acme Shop",
    } as GaFixCounters;
    const html = render(leaked);
    expect(html).not.toContain("987654321");
    expect(html).not.toContain("Acme Shop");
  });
});
