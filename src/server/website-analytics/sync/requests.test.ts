import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GaPropertyLink } from "@prisma/client";

import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import type { GaParsedReport } from "@/lib/website-analytics/response";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Bu dosyanın kanıtladığı: istekler 5'erli toplu çağrılarla gider ve kota
// her yanıttan sonra mülkün bütün bağlarına yazılır; bozuk bir rapor (400)
// toplu çağrıyı düşürünce istekler tek tek denenir ve yalnız o rapor
// "geçersiz" döner; kota yetmezse Google'a hiç gidilmez; sunucu hataları
// sayılır, 429 blok süresi saklanır.

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  runGaReport: vi.fn(),
  runGaReportBatch: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gaPropertyLink: { updateMany: mocks.updateMany } },
}));
vi.mock("@/server/integrations/google-analytics/data-api", () => ({
  GA_BATCH_SIZE: 5,
  runGaReport: mocks.runGaReport,
  runGaReportBatch: mocks.runGaReportBatch,
}));

const { GaQuotaDeferred, runGaRequests } = await import("./requests");
type Context = Parameters<typeof runGaRequests>[0];

const QUOTA = {
  tokensPerHour: { consumed: 100, remaining: 39_900 },
  tokensPerDay: { consumed: 100, remaining: 199_900 },
};

function report(): GaParsedReport {
  return {
    dimensionHeaders: [],
    metricHeaders: [],
    rows: [],
    rowCount: 0,
    quality: {},
    propertyQuota: QUOTA,
  };
}

function ctx(overrides: Partial<Context> = {}): Context {
  return {
    link: { id: "link-1", propertyId: "123" } as GaPropertyLink,
    accessToken: "token",
    timeZone: "UTC",
    today: "2026-10-06",
    now: new Date("2026-10-06T15:20:00.000Z"),
    lane: "P2",
    disabled: new Set(),
    quota: null,
    serverErrors: null,
    rateLimitedUntil: null,
    ...overrides,
  };
}

const requests = (count: number): GaRunReportRequest[] =>
  Array.from({ length: count }, (_, index) => ({
    dateRanges: [{ startDate: "2026-09-29", endDate: "2026-10-05" }],
    metrics: [{ name: `m${index}` }],
  }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.runGaReportBatch.mockImplementation(
    async (_t: string, _p: string, batch: GaRunReportRequest[]) =>
      batch.map(report),
  );
  mocks.runGaReport.mockImplementation(async () => report());
});

describe("runGaRequests", () => {
  it("sends five at a time and stores the quota for the whole property", async () => {
    const context = ctx();
    const outcomes = await runGaRequests(context, requests(12));
    expect(outcomes).toHaveLength(12);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(mocks.runGaReportBatch).toHaveBeenCalledTimes(3);
    expect(
      mocks.runGaReportBatch.mock.calls.map((call) => call[2].length),
    ).toEqual([5, 5, 2]);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { propertyId: "123" },
      data: { lastQuota: expect.objectContaining({ quota: QUOTA }) },
    });
    expect(context.quota?.quota).toEqual(QUOTA);
  });

  it("finds the one broken report when Google rejects the batch", async () => {
    const invalid = new GoogleApiError(
      "Field bogus is not a valid metric",
      "INVALID_ARGUMENT",
      {
        httpStatus: 400,
      },
    );
    mocks.runGaReportBatch.mockRejectedValueOnce(invalid);
    mocks.runGaReport
      .mockResolvedValueOnce(report())
      .mockRejectedValueOnce(invalid)
      .mockResolvedValueOnce(report());
    const outcomes = await runGaRequests(ctx(), requests(3));
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
    expect(mocks.runGaReport).toHaveBeenCalledTimes(3);
  });

  it("waits instead of calling Google when the hourly share is spent", async () => {
    const context = ctx({
      quota: {
        at: "2026-10-06T15:00:00.000Z",
        quota: { tokensPerHour: { consumed: 39_000, remaining: 1_000 } },
      },
    });
    await expect(runGaRequests(context, requests(2))).rejects.toBeInstanceOf(
      GaQuotaDeferred,
    );
    expect(mocks.runGaReportBatch).not.toHaveBeenCalled();
  });

  it("counts Google's server errors and stops background work at three", async () => {
    const serverError = new GoogleApiError("Backend error", "INTERNAL", {
      httpStatus: 500,
    });
    mocks.runGaReport.mockRejectedValue(serverError);
    const context = ctx();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(runGaRequests(context, requests(1))).rejects.toBe(
        serverError,
      );
    }
    expect(context.serverErrors?.count).toBe(3);
    await expect(runGaRequests(context, requests(1))).rejects.toBeInstanceOf(
      GaQuotaDeferred,
    );
    expect(mocks.runGaReport).toHaveBeenCalledTimes(3);
  });

  it("keeps the block Google asked for after a 429", async () => {
    const limited = new GoogleApiError(
      "Too many requests",
      "RESOURCE_EXHAUSTED",
      {
        httpStatus: 429,
        retryAfterMs: 120_000,
      },
    );
    mocks.runGaReport.mockRejectedValue(limited);
    const context = ctx();
    await expect(runGaRequests(context, requests(1))).rejects.toBe(limited);
    expect(context.rateLimitedUntil).toBeInstanceOf(Date);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { propertyId: "123" },
      data: { rateLimitedUntil: context.rateLimitedUntil },
    });
  });
});
