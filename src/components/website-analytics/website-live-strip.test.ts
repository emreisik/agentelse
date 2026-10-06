import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  GaRightNowResult,
  GaTodayResult,
} from "@/lib/website-analytics/live";

const { WebsiteLiveView } = await import("./website-live-strip");

// Canlı şeridin durumları: iki kart da sayı gösterir ("Partial" rozeti,
// mülk saati), kapalı ya da bağsız kart gizlenir, yeniden bağlanma ve kota
// kendi cümlesini söyler, ikisi de gizliyse hiçbir şey çizilmez.

const render = (today: GaTodayResult | null, now: GaRightNowResult | null) =>
  renderToString(createElement(WebsiteLiveView, { today, now }));

const today: GaTodayResult = {
  ok: true,
  cached: false,
  today: {
    day: "2026-10-06",
    asOf: "2026-10-06T11:05:00.000Z",
    timeZone: "Europe/Istanbul",
    sessions: 1234,
    activeUsers: 987,
    newUsers: 400,
    keyEvents: 12,
    screenPageViews: 3000,
  },
};
const now: GaRightNowResult = {
  ok: true,
  cached: true,
  now: { activeUsers: 7, asOf: "2026-10-06T11:05:00.000Z" },
};

describe("WebsiteLiveView", () => {
  it("shows today so far and right now", () => {
    const html = render(today, now);
    expect(html).toContain("Today so far");
    expect(html).toContain("Partial");
    expect(html).toContain("1,234");
    expect(html).toContain("987");
    expect(html).toContain("Key events");
    // 11:05 UTC = 14:05 İstanbul.
    expect(html).toContain("14:05");
    expect(html).toContain("Property time");
    expect(html).toContain("Right now");
    expect(html).toContain("Active users in the last 30 minutes");
    expect(html).toContain("animate-pulse");
  });

  it("shows only today when right now is off", () => {
    const html = render(today, { ok: false, reason: "off" });
    expect(html).toContain("Today so far");
    expect(html).not.toContain("Right now");
  });

  it("asks for a reconnect", () => {
    const html = render(
      { ok: false, reason: "reconnect" },
      { ok: false, reason: "reconnect" },
    );
    expect(html).toContain("Reconnect Google Analytics to see live numbers.");
    expect(html).not.toContain("Active users in the last 30 minutes");
  });

  it("says live numbers are paused on quota or busy", () => {
    const html = render(today, { ok: false, reason: "quota" });
    expect(html).toContain("Live numbers are paused for a moment.");
    expect(render({ ok: false, reason: "busy" }, null)).toContain(
      "Live numbers are paused for a moment.",
    );
    expect(render({ ok: false, reason: "error" }, null)).toContain(
      "Live numbers aren&#x27;t available right now.",
    );
  });

  it("renders nothing when both cards are hidden", () => {
    expect(
      render(
        { ok: false, reason: "off" },
        { ok: false, reason: "not_connected" },
      ),
    ).toBe("");
    expect(render(null, null)).toBe("");
  });

  it("drops the pulse when nobody is on the site", () => {
    const html = render(null, {
      ok: true,
      cached: false,
      now: { activeUsers: 0, asOf: "2026-10-06T11:05:00.000Z" },
    });
    expect(html).toContain("Right now");
    expect(html).not.toContain("animate-pulse");
  });
});
