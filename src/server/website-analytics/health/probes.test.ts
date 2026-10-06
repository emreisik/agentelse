import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GaPropertyLink } from "@prisma/client";

import type { GaParsedReport } from "@/lib/website-analytics/response";
import { GoogleApiError } from "@/server/integrations/google/errors";
import type { GaSyncContext } from "@/server/website-analytics/sync/context";

// Bu dosyanın kanıtladığı: PII yoklaması tek istekle ve bağlamın kanalıyla
// (ctx.lane) gider; Google filtreyi reddederse (VALIDATION) aralığı taşıyan
// "error" sonucu döner; kota ertelemesi ve diğer Google hataları yükselir;
// realtime ölçümü aktif kullanıcı sayısını olduğu gibi döndürür.

const mocks = vi.hoisted(() => ({
  runGaRequests: vi.fn(),
  runGaRealtimeActiveUsers: vi.fn(),
}));

vi.mock("@/server/website-analytics/sync/requests", async () => {
  class GaQuotaDeferred extends Error {
    constructor(
      readonly retryAt: Date,
      readonly reason: string,
    ) {
      super("quota");
      this.name = "GaQuotaDeferred";
    }
  }
  return { runGaRequests: mocks.runGaRequests, GaQuotaDeferred };
});
vi.mock("@/server/integrations/google-analytics/realtime", () => ({
  runGaRealtimeActiveUsers: mocks.runGaRealtimeActiveUsers,
}));

const { runPiiProbe, runRealtimeProbe } = await import("./probes");
const { GaQuotaDeferred } =
  await import("@/server/website-analytics/sync/requests");

function ctx(overrides: Partial<GaSyncContext> = {}): GaSyncContext {
  return {
    link: { id: "link-1", propertyId: "123" } as GaPropertyLink,
    accessToken: "token",
    timeZone: "UTC",
    today: "2026-10-06",
    now: new Date("2026-10-06T12:00:00.000Z"),
    lane: "P2",
    disabled: new Set(),
    quota: null,
    serverErrors: null,
    rateLimitedUntil: null,
    ...overrides,
  };
}

const RANGE = { from: "2026-09-29", to: "2026-10-05", forced: false };

function report(rows: [string, number][]): GaParsedReport {
  return {
    dimensionHeaders: ["pagePathPlusQueryString"],
    metricHeaders: ["screenPageViews"],
    rows: rows.map(([path, views]) => ({
      dimensions: [path],
      metrics: [views],
    })),
    rowCount: rows.length,
    quality: {},
    propertyQuota: null,
  };
}

beforeEach(() => {
  mocks.runGaRequests.mockReset();
  mocks.runGaRealtimeActiveUsers.mockReset();
});

describe("runPiiProbe", () => {
  it("sends one request on the context's lane and evaluates the report", async () => {
    mocks.runGaRequests.mockResolvedValue([
      { ok: true, report: report([["/x?email=a@b.co", 3]]) },
    ]);
    const context = ctx({ lane: "P1" });
    const result = await runPiiProbe(context, { ...RANGE, forced: true });

    expect(mocks.runGaRequests).toHaveBeenCalledTimes(1);
    const [passedCtx, requests, lane] = mocks.runGaRequests.mock.calls[0]!;
    expect(passedCtx).toBe(context);
    expect(lane).toBe("P1");
    expect(requests).toHaveLength(1);
    expect(requests[0].dateRanges).toEqual([
      { startDate: RANGE.from, endDate: RANGE.to },
    ]);
    expect(result).toMatchObject({
      outcome: "ok",
      forced: true,
      pages: 1,
      views: 3,
      email: true,
      params: ["email"],
      at: "2026-10-06T12:00:00.000Z",
    });
  });

  it("records a rejected filter as an error result with the range", async () => {
    mocks.runGaRequests.mockResolvedValue([
      {
        ok: false,
        error: new GoogleApiError("bad filter", "INVALID_ARGUMENT", {
          httpStatus: 400,
        }),
      },
    ]);
    expect(await runPiiProbe(ctx(), RANGE)).toEqual({
      v: 1,
      at: "2026-10-06T12:00:00.000Z",
      from: RANGE.from,
      to: RANGE.to,
      forced: false,
      outcome: "error",
      pages: 0,
      views: 0,
      params: [],
      email: false,
      phone: false,
    });
  });

  it("rethrows quota deferrals and Google errors", async () => {
    const deferred = new GaQuotaDeferred(
      new Date("2026-10-06T13:00:00.000Z"),
      "HOURLY",
    );
    mocks.runGaRequests.mockRejectedValueOnce(deferred);
    await expect(runPiiProbe(ctx(), RANGE)).rejects.toBe(deferred);

    const google = new GoogleApiError("boom", "INTERNAL", { httpStatus: 500 });
    mocks.runGaRequests.mockRejectedValueOnce(google);
    await expect(runPiiProbe(ctx(), RANGE)).rejects.toBe(google);
  });
});

describe("runRealtimeProbe", () => {
  it("returns the active user count", async () => {
    mocks.runGaRealtimeActiveUsers.mockResolvedValue({ activeUsers: 0 });
    expect(await runRealtimeProbe("token", "123")).toBe(0);
    expect(mocks.runGaRealtimeActiveUsers).toHaveBeenCalledWith("token", "123");
  });
});
