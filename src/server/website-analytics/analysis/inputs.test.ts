import type { GaPropertyLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GaAdsCrossCheckInput } from "@/lib/website-analytics/attribution/types";
import {
  makeAdsInput,
  makeWindowTables,
} from "@/lib/website-analytics/analysis/test-fixtures";

// Bu dosyanın kanıtladığı (GA-F6): AN13/AN14 girdisi yoksa (GA_UTM kapalı,
// veri yok ya da okuma patladı) haftalık girdide `ads` anahtarı hiç yoktur;
// varsa 28 günlük pencere, önceki pencere ve iki penceredeki şüpheli günler
// okuyucuya verilir.

const deps = vi.hoisted(() => ({
  loadAdsCrossCheckInput: vi.fn(),
  loadGaWindowTables: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn().mockResolvedValue(null) },
    projectGoal: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/server/website-analytics/attribution/read", () => ({
  loadAdsCrossCheckInput: deps.loadAdsCrossCheckInput,
}));
vi.mock("./windows", () => ({ loadGaWindowTables: deps.loadGaWindowTables }));
vi.mock("@/server/website-analytics/health/read", () => ({
  loadMeasurementSummaryForLink: vi.fn().mockResolvedValue(null),
  readGaSuspectDays: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/server/website-analytics/store", () => ({
  readDailyTotals: vi.fn().mockResolvedValue([]),
  readSlices: vi.fn().mockResolvedValue([]),
  readWeekSlices: vi.fn().mockResolvedValue([]),
}));

const { loadWeeklyAnalysisInput } = await import("./inputs");

const LINK = {
  id: "link-1",
  projectId: "project-1",
  timeZone: "UTC",
  currencyCode: "EUR",
} as unknown as GaPropertyLink;
const WEEK = { monday: "2026-09-28", sunday: "2026-10-04" };
const NOW = new Date("2026-10-07T08:00:00Z");

beforeEach(() => {
  deps.loadAdsCrossCheckInput.mockReset();
  deps.loadGaWindowTables.mockReset();
  deps.loadGaWindowTables.mockImplementation(
    async (_linkId: string, range: { from: string; to: string }) =>
      makeWindowTables(range),
  );
});

describe("loadWeeklyAnalysisInput, ads input (GA-F6)", () => {
  it("has no `ads` key when the reader returns null", async () => {
    deps.loadAdsCrossCheckInput.mockResolvedValue(null);
    const input = await loadWeeklyAnalysisInput(LINK, WEEK, null, NOW);
    expect(Object.hasOwn(input, "ads")).toBe(false);
  });

  it("has no `ads` key when the reader fails", async () => {
    deps.loadAdsCrossCheckInput.mockRejectedValue(new Error("boom"));
    const input = await loadWeeklyAnalysisInput(LINK, WEEK, null, NOW);
    expect(Object.hasOwn(input, "ads")).toBe(false);
  });

  it("passes both 28-day windows and their excluded days to the reader", async () => {
    const ads: GaAdsCrossCheckInput = makeAdsInput();
    deps.loadAdsCrossCheckInput.mockResolvedValue(ads);
    deps.loadGaWindowTables.mockImplementation(
      async (_linkId: string, range: { from: string; to: string }) =>
        makeWindowTables(range, {
          excludedDays: range.to === "2026-10-04" ? ["2026-09-20"] : [],
        }),
    );
    const input = await loadWeeklyAnalysisInput(LINK, WEEK, null, NOW);
    expect(input.ads).toBe(ads);
    expect(deps.loadAdsCrossCheckInput).toHaveBeenCalledTimes(1);
    const call = deps.loadAdsCrossCheckInput.mock.calls[0]![0] as {
      link: GaPropertyLink;
      window: { from: string; to: string };
      previousWindow: { from: string; to: string };
      exclude: ReadonlySet<string>;
    };
    expect(call.link).toBe(LINK);
    expect(call.window).toEqual({ from: "2026-09-07", to: "2026-10-04" });
    expect(call.previousWindow).toEqual({
      from: "2026-08-10",
      to: "2026-09-06",
    });
    expect([...call.exclude]).toEqual(["2026-09-20"]);
  });
});
