import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_INSIGHTS kapalıyken (ctx.insights !== "on")
// loadReportFindings hiç gaFinding sorgusu atmaz ve boş "off" sonucu döner;
// açıkken sorgu atılır ve evaluated istenmedikçe sonuç sayımı yoktur.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaFinding: { findMany: mocks.findMany, groupBy: mocks.groupBy },
  },
}));
vi.mock("@/server/chat/content-plan", () => ({
  getProjectTimezone: vi.fn(),
}));

const { loadReportFindings } = await import("./inputs");

import type { GaReportContext } from "./inputs";

function contextOf(insights: GaReportContext["insights"]): GaReportContext {
  return { insights, link: { id: "l1" } } as unknown as GaReportContext;
}

const RANGE = { from: "2026-09-28", to: "2026-10-04" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([]);
  mocks.groupBy.mockResolvedValue([]);
});

describe("loadReportFindings", () => {
  it.each(["off", "shadow"] as const)(
    "makes no query when insights are %s",
    async (mode) => {
      const result = await loadReportFindings(contextOf(mode), RANGE, {
        insights: "on",
        evaluated: true,
      });
      expect(mocks.findMany).not.toHaveBeenCalled();
      expect(mocks.groupBy).not.toHaveBeenCalled();
      expect(result).toEqual({
        insights: "off",
        changed: [],
        opportunities: [],
        evaluated: [],
        outcomeCounts: null,
      });
    },
  );

  it("queries live findings when insights are on", async () => {
    const result = await loadReportFindings(contextOf("on"), RANGE, {
      insights: "pending",
      evaluated: false,
    });
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    const args = mocks.findMany.mock.calls[0]?.[0] as {
      where: { linkId: string; mode: string };
      take: number;
    };
    expect(args.where).toMatchObject({ linkId: "l1", mode: "live" });
    expect(args.take).toBe(40);
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(result.insights).toBe("pending");
    expect(result.outcomeCounts).toBeNull();
  });

  it("adds evaluated findings and outcome counts when asked", async () => {
    mocks.groupBy.mockResolvedValue([
      { outcome: "WORKED", _count: { _all: 2 } },
      { outcome: "DIDNT", _count: { _all: 1 } },
    ]);
    const result = await loadReportFindings(contextOf("on"), RANGE, {
      insights: "on",
      evaluated: true,
    });
    expect(result.outcomeCounts).toEqual({ worked: 2, didnt: 1, inconclusive: 0 });
    expect(mocks.findMany).toHaveBeenCalledTimes(2);
  });
});
