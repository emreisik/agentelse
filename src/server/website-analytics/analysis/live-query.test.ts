import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GaRunReportRequest } from "@/lib/website-analytics/catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";

// Bu dosyanın kanıtladığı: proje ve mülk günü başına en çok 20 canlı sorgu
// (21.'si "limit", ertesi gün yeniden açılır; başka proje etkilenmez); bayrak
// kapalıyken "off" (sorgusuz); bağ yoksa "not_connected", durmuş bağ ya da
// pasif kimlik "reconnect", Google yetki hatası "reconnect"; mock modda gerçek
// runGaRequests sahte rapor satırları döner ve sayaçlar her çağrıda boşaltılır.

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  primaryGaLink: vi.fn(),
  credentialFindUnique: vi.fn(),
  linkUpdateMany: vi.fn(),
  flush: vi.fn(),
  runGaRequests: { override: null as null | (() => Promise<never>) },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationCredential: { findUnique: mocks.credentialFindUnique },
    gaPropertyLink: { updateMany: mocks.linkUpdateMany },
  },
}));
vi.mock("@/lib/website-analytics/analysis/flags", () => ({
  gaInsightsModeFor: mocks.mode,
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
}));
vi.mock("@/server/website-analytics/api-counters", () => ({
  flushGaApiCounters: mocks.flush,
  recordGaApiOutcome: vi.fn(),
}));
vi.mock("@/server/website-analytics/sync/requests", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server/website-analytics/sync/requests")
    >();
  return {
    ...actual,
    runGaRequests: (...args: Parameters<typeof actual.runGaRequests>) =>
      mocks.runGaRequests.override
        ? mocks.runGaRequests.override()
        : actual.runGaRequests(...args),
  };
});

const {
  runWebsiteLiveQuery,
  resetWebsiteLiveQueryLimits,
  GA_CHAT_LIVE_PER_DAY,
} = await import("./live-query");

const NOW = new Date("2026-10-06T10:00:00.000Z");
const LINK = {
  id: "link-1",
  projectId: "proj-1",
  propertyId: "424242",
  credentialId: "cred-1",
  timeZone: "Europe/Istanbul",
  health: "OK",
  catalog: null,
  lastQuota: null,
  serverErrorsHour: null,
  rateLimitedUntil: null,
};
const REQUEST: GaRunReportRequest = {
  dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-30" }],
  dimensions: [{ name: "sessionSource" }, { name: "landingPage" }],
  metrics: [{ name: "sessions" }, { name: "keyEvents" }],
  limit: 20,
  keepEmptyRows: false,
  returnPropertyQuota: true,
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
  resetWebsiteLiveQueryLimits();
  mocks.mode.mockReset().mockReturnValue("on");
  mocks.primaryGaLink.mockReset().mockResolvedValue(LINK);
  mocks.credentialFindUnique.mockReset().mockResolvedValue({
    id: "cred-1",
    status: "ACTIVE",
    encryptedSecret: "x",
  });
  mocks.linkUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.runGaRequests.override = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runWebsiteLiveQuery", () => {
  it("answers from the mock report through runGaRequests", async () => {
    const result = await runWebsiteLiveQuery("proj-1", REQUEST, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.dimensionHeaders).toEqual([
      "sessionSource",
      "landingPage",
    ]);
    expect(result.report.rows.length).toBeGreaterThan(0);
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });

  it("allows 20 live queries per project per property day", async () => {
    for (let index = 0; index < GA_CHAT_LIVE_PER_DAY; index += 1) {
      const result = await runWebsiteLiveQuery("proj-1", REQUEST, NOW);
      expect(result.ok).toBe(true);
    }
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "limit",
    });
    // Başka proje kendi payını kullanır.
    mocks.primaryGaLink.mockResolvedValue({ ...LINK, projectId: "proj-2" });
    expect((await runWebsiteLiveQuery("proj-2", REQUEST, NOW)).ok).toBe(true);
    // Mülk saatinde ertesi gün pay yenilenir.
    mocks.primaryGaLink.mockResolvedValue(LINK);
    const tomorrow = new Date(NOW.getTime() + 24 * 3_600_000);
    expect((await runWebsiteLiveQuery("proj-1", REQUEST, tomorrow)).ok).toBe(
      true,
    );
  });

  it("keeps another time zone's counter when a project's day rolls over", async () => {
    // 22:30 UTC: İstanbul'da ertesi gün, New York'ta hâlâ aynı gün.
    const late = new Date("2026-10-06T22:30:00.000Z");
    const newYork = { ...LINK, projectId: "proj-ny", timeZone: "America/New_York" };
    mocks.primaryGaLink.mockResolvedValue(newYork);
    for (let index = 0; index < GA_CHAT_LIVE_PER_DAY; index += 1) {
      expect((await runWebsiteLiveQuery("proj-ny", REQUEST, late)).ok).toBe(
        true,
      );
    }
    mocks.primaryGaLink.mockResolvedValue(LINK);
    expect((await runWebsiteLiveQuery("proj-1", REQUEST, late)).ok).toBe(true);
    mocks.primaryGaLink.mockResolvedValue(newYork);
    expect(await runWebsiteLiveQuery("proj-ny", REQUEST, late)).toEqual({
      ok: false,
      reason: "limit",
    });
  });

  it("returns off without any query while the mode is not on", async () => {
    mocks.mode.mockReturnValue("shadow");
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "off",
    });
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });

  it("maps a missing link, a stopped link and an inactive credential", async () => {
    mocks.primaryGaLink.mockResolvedValueOnce(null);
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "not_connected",
    });
    mocks.primaryGaLink.mockResolvedValueOnce({ ...LINK, health: "AUTH" });
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "reconnect",
    });
    mocks.credentialFindUnique.mockResolvedValueOnce({
      id: "cred-1",
      status: "REVOKED",
      encryptedSecret: "x",
    });
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "reconnect",
    });
  });

  it("maps a Google permission error to reconnect", async () => {
    mocks.runGaRequests.override = async () => {
      throw new GoogleApiError("no access", "PERMISSION_DENIED", {
        errorClass: "PERMISSION",
      });
    };
    expect(await runWebsiteLiveQuery("proj-1", REQUEST, NOW)).toEqual({
      ok: false,
      reason: "reconnect",
    });
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });
});
