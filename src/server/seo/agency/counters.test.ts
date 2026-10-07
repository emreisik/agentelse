import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  queryRaw: vi.fn(),
  bq: vi.fn(),
  split: vi.fn(),
  shares: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gscSiteLink: { count: mocks.count }, $queryRaw: mocks.queryRaw },
}));
vi.mock("@/server/report-share/counters", () => ({ loadShareCounters: mocks.shares }));
vi.mock("@/server/seo/agency/bq/counters", () => ({ loadBqCounters: mocks.bq }));
vi.mock("@/server/seo/agency/split/counters", () => ({ loadSplitCounters: mocks.split }));

const { loadGscAgencyCounters } = await import("./counters");

const BQ = { sources: 1, active: 1, error: 0, budget: 0, paused: 0, periodsImported7d: 5, bytesBilledThisMonth: 10 };
const SPLIT = { open: 1, applied: 0, evaluating: 0, evaluated30d: { worked: 0, didnt: 0, inconclusive: 0 }, expired30d: 0 };
const SHARES = { active: 2, created7d: 1, viewed7d: 4, brandedWorkspaces: 1 };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("GSC_AGENCY", "true");
  // CI mock kipte koşar; sayaç sorgusu canlı kipi (isMock: false) varsayar.
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  mocks.count.mockReset().mockResolvedValue(3);
  mocks.queryRaw.mockReset().mockResolvedValue([{ count: BigInt(2) }]);
  mocks.bq.mockReset().mockResolvedValue(BQ);
  mocks.split.mockReset().mockResolvedValue(SPLIT);
  mocks.shares.mockReset().mockResolvedValue(SHARES);
});

describe("loadGscAgencyCounters", () => {
  it("is null with no query when the flag is off", async () => {
    vi.stubEnv("GSC_AGENCY", "");
    expect(await loadGscAgencyCounters()).toBeNull();
    expect(mocks.count).not.toHaveBeenCalled();
    expect(mocks.bq).not.toHaveBeenCalled();
  });

  it("collects counters only", async () => {
    expect(await loadGscAgencyCounters(new Date("2026-10-07T00:00:00Z"))).toEqual({
      extraSites: 3,
      pageGroupRuleSets: 2,
      bigQuery: BQ,
      splitTests: SPLIT,
      shares: SHARES,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { isSecondary: true, isMock: false } });
  });

  it("turns a failing part into null (or 0) and keeps the rest", async () => {
    mocks.bq.mockRejectedValue(new Error("x"));
    mocks.split.mockResolvedValue(null);
    mocks.shares.mockRejectedValue(new Error("x"));
    mocks.count.mockRejectedValue(new Error("x"));
    const result = await loadGscAgencyCounters();
    expect(result).toEqual({
      extraSites: 0,
      pageGroupRuleSets: 2,
      bigQuery: null,
      splitTests: null,
      shares: null,
    });
  });
});
