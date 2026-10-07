import { beforeEach, describe, expect, it, vi } from "vitest";

// Sayaçlar: bayrak kapalıyken null ve sorgu yok; açıkken yalnız sayılar.

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  brandingCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reportShare: { count: mocks.count },
    reportBranding: { count: mocks.brandingCount },
  },
}));

import { loadShareCounters } from "./counters";

const NOW = new Date("2026-10-07T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_AGENCY", "false");
  vi.stubEnv("GA_AGENCY", "false");
});

describe("loadShareCounters", () => {
  it("returns null without a query when both flags are off", async () => {
    expect(await loadShareCounters(NOW)).toBeNull();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.brandingCount).not.toHaveBeenCalled();
  });

  it("returns counts only when a flag is on", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    mocks.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(17);
    mocks.brandingCount.mockResolvedValue(3);
    expect(await loadShareCounters(NOW)).toEqual({
      active: 4,
      created7d: 2,
      viewed7d: 17,
      brandedWorkspaces: 3,
    });
    const since = new Date(NOW.getTime() - 7 * 86_400_000);
    expect(mocks.count.mock.calls[0]?.[0].where).toEqual({
      revokedAt: null,
      expiresAt: { gt: NOW },
    });
    expect(mocks.count.mock.calls[1]?.[0].where).toEqual({
      createdAt: { gte: since },
    });
    expect(mocks.count.mock.calls[2]?.[0].where).toEqual({
      lastViewedAt: { gte: since },
    });
  });
});
