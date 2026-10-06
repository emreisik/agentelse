import { describe, expect, it } from "vitest";

import {
  overviewTrend,
  overviewWindow,
  websiteHealthTone,
} from "./overview";

// Brand kartının saf kuralları: ±%3 eşiği, sağlık noktası (hata > geciken
// veri > tamam) ve veriye bağlı 28 günlük pencere.

describe("overviewTrend", () => {
  it("is up from +3%, down from -3% and flat between", () => {
    expect(overviewTrend(3)).toBe("up");
    expect(overviewTrend(12.4)).toBe("up");
    expect(overviewTrend(2.99)).toBe("flat");
    expect(overviewTrend(0)).toBe("flat");
    expect(overviewTrend(-2.99)).toBe("flat");
    expect(overviewTrend(-3)).toBe("down");
    expect(overviewTrend(null)).toBeNull();
  });
});

describe("websiteHealthTone", () => {
  const today = "2026-10-06";

  it("maps link health to a tone and label", () => {
    const tone = (health: string, dataThrough: string | null = "2026-10-05") =>
      websiteHealthTone({ health, dataThrough, today });
    expect(tone("OK")).toEqual({ tone: "ok", label: "Up to date" });
    expect(tone("UNKNOWN")).toEqual({ tone: "unknown", label: "Checking" });
    expect(tone("DEGRADED")).toEqual({
      tone: "warning",
      label: "Updates are failing",
    });
    expect(tone("AUTH")).toEqual({ tone: "error", label: "Reconnect needed" });
    expect(tone("NEEDS_PERMISSION")).toEqual({
      tone: "error",
      label: "Reconnect needed",
    });
    for (const health of ["ACCESS_LOST", "GONE", "API_DISABLED"]) {
      expect(tone(health)).toEqual({
        tone: "error",
        label: "Can't read the property",
      });
    }
  });

  it("says data is late when the last day is older than today-3", () => {
    expect(
      websiteHealthTone({ health: "OK", dataThrough: "2026-10-03", today }),
    ).toEqual({ tone: "ok", label: "Up to date" });
    expect(
      websiteHealthTone({ health: "OK", dataThrough: "2026-10-02", today }),
    ).toEqual({ tone: "warning", label: "Data is late" });
    expect(
      websiteHealthTone({ health: "OK", dataThrough: null, today }),
    ).toEqual({ tone: "ok", label: "Up to date" });
  });

  it("lets an error win over late data", () => {
    expect(
      websiteHealthTone({ health: "AUTH", dataThrough: "2026-09-01", today }),
    ).toEqual({ tone: "error", label: "Reconnect needed" });
  });
});

describe("overviewWindow", () => {
  it("anchors on yesterday when the warehouse has it", () => {
    expect(overviewWindow("2026-10-06", "2026-10-06")).toEqual({
      current: { from: "2026-09-08", to: "2026-10-05" },
      previous: { from: "2026-08-11", to: "2026-09-07" },
    });
    expect(overviewWindow("2026-10-06", "2026-10-05")).toEqual({
      current: { from: "2026-09-08", to: "2026-10-05" },
      previous: { from: "2026-08-11", to: "2026-09-07" },
    });
  });

  it("anchors on the last stored day when it is before yesterday", () => {
    expect(overviewWindow("2026-10-06", "2026-10-04")).toEqual({
      current: { from: "2026-09-07", to: "2026-10-04" },
      previous: { from: "2026-08-10", to: "2026-09-06" },
    });
  });

  it("is null without data", () => {
    expect(overviewWindow("2026-10-06", null)).toBeNull();
  });
});
