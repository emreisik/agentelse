import type { GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { addDays } from "@/lib/seo/dates";
import type { SeoReportHealth } from "@/lib/seo/reports/types";
import type { GscDayRow } from "@/server/seo/store";

const mocks = vi.hoisted(() => ({
  readGscDays: vi.fn(),
  findSlices: vi.fn(),
  countNewCriticalAlerts: vi.fn(),
  readHealthSummary: vi.fn(),
  readOpenSearchAlerts: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gscDailySlice: { findMany: mocks.findSlices } },
}));
vi.mock("@/server/seo/store", () => ({ readGscDays: mocks.readGscDays }));
vi.mock("./inputs", () => ({
  countNewCriticalAlerts: mocks.countNewCriticalAlerts,
  readHealthSummary: mocks.readHealthSummary,
  readOpenSearchAlerts: mocks.readOpenSearchAlerts,
}));

import { buildPulseReport } from "./pulse";
import type { ReportLinkContext } from "./inputs";

// Pazar; geçmiş aynı hafta günleri Pazar'lardır.
const DAY = "2026-10-04";
const NOW = new Date("2026-10-07T12:00:00Z");
const SINCE = new Date("2026-10-04T12:00:00Z");

function context(isMock = false): ReportLinkContext {
  return {
    link: { id: "link1", isMock } as unknown as GscSiteLink,
    projectId: "p1",
    workspaceId: "w1",
    brandId: "b1",
    language: "en",
    timezone: "UTC",
    finalThrough: DAY,
    brandSplitReady: true,
    siteLabel: "example.com",
  };
}

function row(
  day: string,
  clicks: number,
  brandClicks: number | null,
  fresh = false,
): GscDayRow {
  return {
    day,
    searchType: "web",
    fresh,
    clicks,
    impressions: clicks * 20,
    positionWeighted: clicks * 20 * 5,
    brandClicks,
    brandImpressions: brandClicks === null ? null : brandClicks * 10,
    brandPositionWeighted: brandClicks === null ? null : brandClicks * 10 * 2,
  };
}

// Aynı hafta günü geçmişi: D−7 … D−56, her biri markasız 60 (100 − 40).
function history(brand: number | null = 40, count = 8): GscDayRow[] {
  return Array.from({ length: count }, (_, i) =>
    row(addDays(DAY, -7 * (i + 1)), 100, brand),
  );
}

function setDays(today: GscDayRow | null, past: GscDayRow[]) {
  mocks.readGscDays.mockResolvedValue(today ? [...past, today] : past);
}

const HEALTH: SeoReportHealth = {
  score: 60,
  cappedByCritical: true,
  critical: 1,
  warn: 0,
  issues: [{ title: "Key page is noindex", severity: "CRITICAL" }],
  coverage: null,
  cwv: null,
};

describe("buildPulseReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findSlices.mockResolvedValue([]);
    mocks.countNewCriticalAlerts.mockResolvedValue(0);
    mocks.readOpenSearchAlerts.mockResolvedValue(null);
    mocks.readHealthSummary.mockResolvedValue(null);
  });

  it("stays quiet on an ordinary day", async () => {
    // markasız 58, olağan 60
    setDays(row(DAY, 98, 40), history());
    expect(
      await buildPulseReport(context(), DAY, { since: SINCE, now: NOW }),
    ).toEqual({ skipped: "quiet" });
  });

  it("posts a pulse for a 40% drop against a usual value of 60", async () => {
    // markasız 36, olağan 60
    setDays(row(DAY, 76, 40), history());
    const result = await buildPulseReport(context(), DAY, {
      since: SINCE,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "pulse") throw new Error("pulse beklendi");
    expect(section.pulse).toMatchObject({
      day: DAY,
      metric: "nonBrandClicks",
      value: 36,
      usual: 60,
      newCritical: 0,
      openCritical: 0,
      biggest: null,
    });
    expect(section.pulse.changePct).toBeCloseTo(-0.4, 5);
    expect(result.snapshot).toMatchObject({
      kind: "PULSE",
      title: "Search pulse",
      periodKey: `D:${DAY}`,
      period: { from: DAY, to: DAY, label: "Oct 4" },
      compare: null,
      yearAgo: null,
      anonymousShare: null,
      finalThrough: DAY,
      site: { label: "example.com", isMock: false },
    });
    // Kritik uyarı yokken sağlık bölümü eklenmez.
    expect(result.snapshot.sections).toHaveLength(1);
    expect(mocks.readHealthSummary).not.toHaveBeenCalled();
  });

  it("is notable on a normal day when a new CRITICAL alert appeared since the last check", async () => {
    setDays(row(DAY, 100, 40), history());
    mocks.countNewCriticalAlerts.mockResolvedValue(2);
    const result = await buildPulseReport(context(), DAY, {
      since: SINCE,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "pulse") throw new Error("pulse beklendi");
    expect(section.pulse.newCritical).toBe(2);
    expect(mocks.countNewCriticalAlerts).toHaveBeenCalledWith("p1", SINCE, NOW);
  });

  it("does not count new alerts on the first check (no since)", async () => {
    setDays(row(DAY, 100, 40), history());
    mocks.countNewCriticalAlerts.mockResolvedValue(2);
    expect(
      await buildPulseReport(context(), DAY, { since: null, now: NOW }),
    ).toEqual({ skipped: "quiet" });
    expect(mocks.countNewCriticalAlerts).not.toHaveBeenCalled();
  });

  it("adds the health section only while a CRITICAL alert is open", async () => {
    setDays(row(DAY, 76, 40), history());
    mocks.readOpenSearchAlerts.mockResolvedValue([
      { kind: "SEO_ROBOTS_BLOCK", title: "Robots block", severity: "CRITICAL" },
      { kind: "GSC_LOST_URLS", title: "Lost pages", severity: "WARN" },
    ]);
    mocks.readHealthSummary.mockResolvedValue(HEALTH);
    const result = await buildPulseReport(context(), DAY, {
      since: null,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    expect(result.snapshot.sections.map((section) => section.type)).toEqual([
      "pulse",
      "health",
    ]);
    const pulse = result.snapshot.sections[0];
    if (pulse?.type !== "pulse") return;
    expect(pulse.pulse.openCritical).toBe(1);

    mocks.readOpenSearchAlerts.mockResolvedValue([
      { kind: "GSC_LOST_URLS", title: "Lost pages", severity: "WARN" },
    ]);
    const warnOnly = await buildPulseReport(context(), DAY, {
      since: null,
      now: NOW,
    });
    if (!("snapshot" in warnOnly)) throw new Error("nabız beklendi");
    expect(warnOnly.snapshot.sections).toHaveLength(1);
  });

  it("falls back to total clicks when the history has fewer than 3 brand values", async () => {
    // Geçmişin yalnız 2 günü marka değeri taşıyor.
    const past = history(null);
    past[0] = row(past[0]!.day, 100, 40);
    past[1] = row(past[1]!.day, 100, 40);
    setDays(row(DAY, 50, 40), past);
    const result = await buildPulseReport(context(), DAY, {
      since: SINCE,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "pulse") throw new Error("pulse beklendi");
    expect(section.pulse).toMatchObject({
      metric: "clicks",
      value: 50,
      usual: 100,
    });
  });

  it("falls back to total clicks when the day itself has no brand value", async () => {
    setDays(row(DAY, 50, null), history());
    const result = await buildPulseReport(context(), DAY, {
      since: SINCE,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "pulse") throw new Error("pulse beklendi");
    expect(section.pulse.metric).toBe("clicks");
  });

  it("has no usual value with fewer than 3 same-weekday days", async () => {
    setDays(row(DAY, 10, 2), history(40, 2));
    expect(
      await buildPulseReport(context(), DAY, { since: SINCE, now: NOW }),
    ).toEqual({ skipped: "quiet" });
  });

  it("skips a missing or fresh day as not_final", async () => {
    setDays(null, history());
    expect(
      await buildPulseReport(context(), DAY, { since: SINCE, now: NOW }),
    ).toEqual({ skipped: "not_final" });
    setDays(row(DAY, 76, 40, true), history());
    expect(
      await buildPulseReport(context(), DAY, { since: SINCE, now: NOW }),
    ).toEqual({ skipped: "not_final" });
    // Kesin günden sonraki gün hiç okunmaz.
    mocks.readGscDays.mockClear();
    expect(
      await buildPulseReport(context(), addDays(DAY, 1), {
        since: SINCE,
        now: NOW,
      }),
    ).toEqual({ skipped: "not_final" });
    expect(mocks.readGscDays).not.toHaveBeenCalled();
  });

  it("ignores fresh days in the history", async () => {
    const past = history();
    // İlk üç geçmiş günü taze: geriye 5 gün kalır, olağan yine 60.
    for (let i = 0; i < 3; i += 1) {
      past[i] = row(past[i]!.day, 900, 0, true);
    }
    setDays(row(DAY, 76, 40), past);
    const result = await buildPulseReport(context(), DAY, {
      since: SINCE,
      now: NOW,
    });
    if (!("snapshot" in result)) throw new Error("nabız beklendi");
    const section = result.snapshot.sections[0];
    if (section?.type !== "pulse") throw new Error("pulse beklendi");
    expect(section.pulse.usual).toBe(60);
  });

  it("reads the country and device slices for the day and the four weeks before in one query", async () => {
    setDays(row(DAY, 76, 40), history());
    await buildPulseReport(context(), DAY, { since: SINCE, now: NOW });
    expect(mocks.findSlices).toHaveBeenCalledTimes(1);
    const args = mocks.findSlices.mock.calls[0]![0] as {
      where: { linkId: string; kind: { in: string[] }; date: { in: Date[] } };
    };
    expect(args.where.linkId).toBe("link1");
    expect(args.where.kind.in).toEqual(["country", "device"]);
    expect(
      args.where.date.in.map((date) => date.toISOString().slice(0, 10)),
    ).toEqual([DAY, "2026-09-27", "2026-09-20", "2026-09-13", "2026-09-06"]);
  });
});
