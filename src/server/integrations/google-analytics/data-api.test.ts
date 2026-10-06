import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GaPropertyLink } from "@prisma/client";

import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import {
  GaQuotaDeferred,
  runGaRequests,
} from "@/server/website-analytics/sync/requests";

// Bu dosyanın kanıtladığı (GA-F2 bölüm 2, /health sayaçları): Data API
// çağrılarının sonucu data-api.ts'te sayılır — toplu çağrı istek sayısı kadar
// "ok", Google hatası bir kez hata sınıfıyla; geçersiz rapor yüzünden düşen
// toplu çağrı "VALIDATION" sayılır ve tek tek denenen istekler ayrıca sayılır;
// kota beklerken (GaQuotaDeferred) Google'a gidilmez ve hiçbir şey sayılmaz.
// requests.ts'in kendisi saymaz (requests.test.ts data-api'yi taklit ettiği
// için bu iddialar burada).

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  googleFetchJson: vi.fn(),
  recordGaApiOutcome: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gaPropertyLink: { updateMany: mocks.updateMany } },
}));
vi.mock("@/server/integrations/google/http", () => ({
  googleFetchJson: mocks.googleFetchJson,
}));
vi.mock("@/server/website-analytics/api-counters", () => ({
  recordGaApiOutcome: mocks.recordGaApiOutcome,
}));

type Context = Parameters<typeof runGaRequests>[0];

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

const RAW = { rows: [], rowCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.googleFetchJson.mockImplementation(
    async (url: string, init: { body: string }) =>
      url.endsWith(":batchRunReports")
        ? {
            reports: (
              JSON.parse(init.body) as { requests: unknown[] }
            ).requests.map(() => RAW),
          }
        : RAW,
  );
});

describe("GA API counters at the Data API", () => {
  it("counts a batch of five as five ok calls", async () => {
    await runGaRequests(ctx(), requests(5));
    expect(mocks.googleFetchJson).toHaveBeenCalledTimes(1);
    expect(mocks.recordGaApiOutcome.mock.calls).toEqual([["ok", 5]]);
  });

  it("counts a server error once by its class", async () => {
    mocks.googleFetchJson.mockRejectedValue(
      new GoogleApiError("Backend error", "INTERNAL", { httpStatus: 500 }),
    );
    await expect(runGaRequests(ctx(), requests(1))).rejects.toBeInstanceOf(
      GoogleApiError,
    );
    expect(mocks.recordGaApiOutcome.mock.calls).toEqual([["SERVER_ERROR"]]);
  });

  it("counts the rejected batch and each retried request", async () => {
    const invalid = new GoogleApiError(
      "Field bogus is not a valid metric",
      "INVALID_ARGUMENT",
      { httpStatus: 400 },
    );
    mocks.googleFetchJson
      .mockRejectedValueOnce(invalid)
      .mockResolvedValueOnce(RAW)
      .mockRejectedValueOnce(invalid)
      .mockResolvedValueOnce(RAW);
    const outcomes = await runGaRequests(ctx(), requests(3));
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, false, true]);
    expect(mocks.recordGaApiOutcome.mock.calls).toEqual([
      ["VALIDATION"],
      ["ok", 1],
      ["VALIDATION"],
      ["ok", 1],
    ]);
  });

  it("counts nothing while the quota makes the work wait", async () => {
    const context = ctx({
      quota: {
        at: "2026-10-06T15:00:00.000Z",
        quota: { tokensPerHour: { consumed: 39_000, remaining: 1_000 } },
      },
    });
    await expect(runGaRequests(context, requests(2))).rejects.toBeInstanceOf(
      GaQuotaDeferred,
    );
    expect(mocks.googleFetchJson).not.toHaveBeenCalled();
    expect(mocks.recordGaApiOutcome).not.toHaveBeenCalled();
  });

  it("counts mock calls too", async () => {
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    await runGaRequests(ctx(), requests(2));
    expect(mocks.googleFetchJson).not.toHaveBeenCalled();
    expect(mocks.recordGaApiOutcome.mock.calls).toEqual([["ok", 2]]);
  });
});
