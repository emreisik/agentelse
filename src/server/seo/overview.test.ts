import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dayRange } from "@/lib/seo/dates";

// Bu dosyanın kanıtladığı: Brand sekmesindeki Search kartının verisi bayrak
// kapalıyken hiç okunmaz; bağ ya da kesin gün yoksa "not_synced" döner; son
// 28 kesin gün ve önceki 28 gün toplanır (taze günler sayılmaz); 28 gün eksikse
// "not_synced", önceki pencere eksikse karşılaştırma yok; marka dışı
// tıklamalar yalnız ayrım hazırsa ve her günün marka değeri varsa verilir.

const primaryGscLink = vi.fn();
const readGscDays = vi.fn();
vi.mock("@/server/seo/store", () => ({ primaryGscLink, readGscDays }));

const brandSplitStatus = vi.fn();
vi.mock("@/server/seo/brand-terms", () => ({ brandSplitStatus }));

const { loadSearchOverview } = await import("./overview");

const LINK = {
  id: "link-1",
  projectId: "proj-1",
  lastFinalDate: "2026-10-03",
  health: "OK",
  isMock: false,
  brandTerms: null,
  brandSeriesHash: null,
};

type Day = {
  day: string;
  clicks: number;
  brandClicks: number | null;
  fresh?: boolean;
};

const row = ({ day, clicks, brandClicks, fresh = false }: Day) => ({
  day,
  searchType: "web",
  fresh,
  clicks,
  impressions: clicks * 10,
  positionWeighted: clicks * 30,
  brandClicks,
  brandImpressions: brandClicks === null ? null : brandClicks * 10,
  brandPositionWeighted: brandClicks === null ? null : brandClicks * 20,
});

const CURRENT = ["2026-09-06", "2026-10-03"] as const;
const PREVIOUS = ["2026-08-09", "2026-09-05"] as const;

// Pencerenin her günü 1 tık (marka 0); `overrides` gün başına [tık, marka].
function fullWindow(
  [from, to]: readonly [string, string],
  overrides: Record<string, [number, number | null]> = {},
) {
  return dayRange(from, to).map((day) => {
    const [clicks, brandClicks] = overrides[day] ?? [1, 0];
    return row({ day, clicks, brandClicks });
  });
}

beforeEach(() => {
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_SEARCH_PAGE", "true");
  primaryGscLink.mockReset().mockResolvedValue(LINK);
  readGscDays.mockReset();
  brandSplitStatus.mockReset().mockReturnValue("ready");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadSearchOverview", () => {
  it("is off without reading anything when GSC_SYNC is off", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    expect(await loadSearchOverview("proj-1")).toEqual({
      ok: false,
      reason: "off",
    });
    expect(primaryGscLink).not.toHaveBeenCalled();
  });

  it("is not_synced without a primary link or a final day", async () => {
    primaryGscLink.mockResolvedValueOnce(null);
    expect(await loadSearchOverview("proj-1")).toEqual({
      ok: false,
      reason: "not_synced",
    });
    primaryGscLink.mockResolvedValueOnce({ ...LINK, lastFinalDate: null });
    expect(await loadSearchOverview("proj-1")).toEqual({
      ok: false,
      reason: "not_synced",
    });
    expect(readGscDays).not.toHaveBeenCalled();
  });

  it("sums the last 28 final days and the 28 before, with the brand split when ready", async () => {
    readGscDays
      .mockResolvedValueOnce([
        ...fullWindow(CURRENT, {
          "2026-09-06": [10, 4],
          "2026-10-03": [20, 6],
        }),
        // Kesinleşmemiş gün hiçbir toplama girmez.
        row({ day: "2026-10-03", clicks: 999, brandClicks: 0, fresh: true }),
      ])
      .mockResolvedValueOnce(
        fullWindow(PREVIOUS, { "2026-08-09": [5, 1], "2026-09-05": [7, 1] }),
      );

    const overview = await loadSearchOverview("proj-1");

    expect(readGscDays).toHaveBeenNthCalledWith(
      1,
      "link-1",
      "2026-09-06",
      "2026-10-03",
    );
    expect(readGscDays).toHaveBeenNthCalledWith(
      2,
      "link-1",
      "2026-08-09",
      "2026-09-05",
    );
    expect(overview).toMatchObject({
      ok: true,
      from: "2026-09-06",
      to: "2026-10-03",
      finalThrough: "2026-10-03",
      clicks: 56,
      previousClicks: 38,
      nonBrandClicks: 46,
      previousNonBrandClicks: 36,
      health: "OK",
      pageHref: "/projects/proj-1/arama",
      isMock: false,
    });
    if (!overview.ok) throw new Error("expected ok");
    expect(overview.trend).toHaveLength(28);
    expect(overview.trend[0]).toBe(6);
    expect(overview.trend[27]).toBe(14);
    expect(overview.trend[1]).toBe(1);
  });

  it("is not_synced while the current 28 days are incomplete", async () => {
    readGscDays
      .mockResolvedValueOnce(fullWindow(CURRENT).slice(1))
      .mockResolvedValueOnce(fullWindow(PREVIOUS));
    expect(await loadSearchOverview("proj-1")).toEqual({
      ok: false,
      reason: "not_synced",
    });
  });

  it("does not compare with an incomplete previous window", async () => {
    readGscDays
      .mockResolvedValueOnce(fullWindow(CURRENT))
      .mockResolvedValueOnce(fullWindow(PREVIOUS).slice(0, 3));
    expect(await loadSearchOverview("proj-1")).toMatchObject({
      ok: true,
      clicks: 28,
      previousClicks: null,
      nonBrandClicks: 28,
      previousNonBrandClicks: null,
    });
  });

  it("gives no brand values when the split is not ready or a day lacks them", async () => {
    brandSplitStatus.mockReturnValue("pending");
    readGscDays
      .mockResolvedValueOnce(fullWindow(CURRENT, { "2026-10-03": [20, 6] }))
      .mockResolvedValueOnce([]);
    const pending = await loadSearchOverview("proj-1");
    expect(pending).toMatchObject({
      ok: true,
      clicks: 47,
      previousClicks: null,
      nonBrandClicks: null,
      previousNonBrandClicks: null,
    });
    if (!pending.ok) throw new Error("expected ok");
    expect(pending.trend[27]).toBe(20);

    brandSplitStatus.mockReturnValue("ready");
    readGscDays
      .mockResolvedValueOnce(
        fullWindow(CURRENT, {
          "2026-10-02": [8, 2],
          "2026-10-03": [20, null],
        }),
      )
      .mockResolvedValueOnce([]);
    expect(await loadSearchOverview("proj-1")).toMatchObject({
      ok: true,
      clicks: 54,
      nonBrandClicks: null,
    });
  });

  it("has no page link while the Search page is off", async () => {
    vi.stubEnv("GSC_SEARCH_PAGE", "false");
    readGscDays.mockResolvedValue(fullWindow(CURRENT));
    expect(await loadSearchOverview("proj-1")).toMatchObject({
      ok: true,
      pageHref: null,
    });
  });
});
