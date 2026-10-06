import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WebsiteOverview } from "@/lib/website-analytics/overview";

const { WebsiteOverviewView } = await import("./website-overview-card");

// Brand sekmesindeki Website kartı: sayılar, trend okunun ekran okuyucu
// metni, sağlık etiketi ve /site bağlantısı; yüklenirken ve veri yokken kart
// çizilmez.

const render = (
  state: Parameters<typeof WebsiteOverviewView>[0]["state"],
) =>
  renderToStaticMarkup(
    createElement(WebsiteOverviewView, { projectId: "proj-1", state }),
  );

const overview: WebsiteOverview = {
  ok: true,
  propertyName: "Web",
  days: 28,
  sessions: 5432,
  keyEvents: 87,
  sessionsChange: 12.3,
  keyEventsChange: -4,
  trend: "up",
  health: "ok",
  healthLabel: "Up to date",
  dataThrough: "2026-10-05",
};

describe("WebsiteOverviewView", () => {
  it("renders the 28-day numbers, trend, health and Open link", () => {
    const html = render({ status: "done", overview });
    expect(html).toContain('data-card="website-overview"');
    expect(html).toContain('aria-label="Website"');
    expect(html).toContain("5,432");
    expect(html).toContain("Sessions, 28 days");
    expect(html).toContain("87");
    expect(html).toContain("Key events");
    expect(html).toContain("▲");
    expect(html).toContain("up 12% vs previous 28 days");
    expect(html).toContain("Up to date · Data through Oct 5");
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain('href="/projects/proj-1/site"');
  });

  it("shows a falling trend and a warning dot", () => {
    const html = render({
      status: "done",
      overview: {
        ...overview,
        sessionsChange: -8.6,
        trend: "down",
        health: "warning",
        healthLabel: "Data is late",
      },
    });
    expect(html).toContain("▼");
    expect(html).toContain("down 9% vs previous 28 days");
    expect(html).toContain("Data is late");
    expect(html).toContain("bg-amber-500");
  });

  it("leaves out the arrow without a comparison", () => {
    const html = render({
      status: "done",
      overview: { ...overview, sessionsChange: null, trend: null },
    });
    expect(html).not.toContain("vs previous 28 days");
  });

  it("renders nothing while loading or without data", () => {
    expect(render({ status: "loading" })).toBe("");
    expect(
      render({ status: "done", overview: { ok: false, reason: "not_synced" } }),
    ).toBe("");
    expect(
      render({ status: "done", overview: { ok: false, reason: "off" } }),
    ).toBe("");
  });
});
