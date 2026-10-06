import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: saklama bayraktan bağımsızdır ama boşa çalışmaz:
// bayrak kapalı ve motor durumu yoksa 0 (claimPeriodic alınmaz); bayrak
// kapalı ama motor verisi kaldıysa çalışır; bayrak kapalı ve veri yokken
// varlık sorgusu 24 saatte bir yapılır; geliştirme süreci (canlı DB
// paylaşılırken) hiç çalıştırmaz.

const mocks = vi.hoisted(() => ({
  stateFindFirst: vi.fn(),
  findingFindMany: vi.fn(),
  findingDeleteMany: vi.fn(),
  clusterDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoEngineState: { findFirst: mocks.stateFindFirst },
    seoFinding: {
      findMany: mocks.findingFindMany,
      deleteMany: mocks.findingDeleteMany,
    },
    seoCluster: { deleteMany: mocks.clusterDeleteMany },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

const { SeoOpportunityRetention } = await import("./retention");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_INSIGHTS",
  "GSC_SYNC",
  "NODE_ENV",
  "DATABASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};
// NODE_ENV salt okunur tiplidir; testte ortam yazılabilir kayıt olarak ele alınır.
const env = process.env as Record<string, string | undefined>;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  SeoOpportunityRetention.resetIdleCheck();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv({ SEO_INSIGHTS: "off", GSC_SYNC: "true", NODE_ENV: "test" });
  mocks.stateFindFirst.mockResolvedValue(null);
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.findingFindMany.mockResolvedValue([{ id: "f1" }, { id: "f2" }]);
  mocks.findingDeleteMany.mockResolvedValue({ count: 2 });
  mocks.clusterDeleteMany.mockResolvedValue({ count: 1 });
  mocks.executeRaw.mockResolvedValue(3);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

describe("SeoOpportunityRetention.runDue", () => {
  it("does nothing when the flag is off and no engine state exists", async () => {
    expect(await SeoOpportunityRetention.runDue(NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.findingDeleteMany).not.toHaveBeenCalled();
  });

  it("checks for engine data at most once a day while the flag is off", async () => {
    expect(await SeoOpportunityRetention.runDue(NOW)).toBe(0);
    expect(
      await SeoOpportunityRetention.runDue(
        new Date(NOW.getTime() + 60 * 60_000),
      ),
    ).toBe(0);
    expect(mocks.stateFindFirst).toHaveBeenCalledTimes(1);
    await SeoOpportunityRetention.runDue(
      new Date(NOW.getTime() + 24 * 3_600_000),
    );
    expect(mocks.stateFindFirst).toHaveBeenCalledTimes(2);
  });

  it("runs with the flag off while engine data remains", async () => {
    mocks.stateFindFirst.mockResolvedValue({ id: "s1" });
    expect(await SeoOpportunityRetention.runDue(NOW)).toBe(6);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "seo.opportunities-retention",
      24 * 3_600_000,
      NOW,
    );
    expect(mocks.findingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { lt: new Date(NOW.getTime() - 730 * 86_400_000) },
        },
      }),
    );
    expect(mocks.clusterDeleteMany).toHaveBeenCalledWith({
      where: {
        status: "STALE",
        updatedAt: { lt: new Date(NOW.getTime() - 56 * 86_400_000) },
      },
    });
  });

  it("runs when the engine is active without reading the state table", async () => {
    setEnv({ SEO_INSIGHTS: "shadow", GSC_SYNC: "true", NODE_ENV: "test" });
    await SeoOpportunityRetention.runDue(NOW);
    expect(mocks.stateFindFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).toHaveBeenCalled();
  });

  it("never runs in the dev process sharing the live database", async () => {
    setEnv({
      SEO_INSIGHTS: "on",
      GSC_SYNC: "true",
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user@db.example.neon.tech/main",
    });
    expect(await SeoOpportunityRetention.runDue(NOW)).toBe(0);
    expect(mocks.stateFindFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  });

  it("stops when another process holds the daily claim", async () => {
    mocks.stateFindFirst.mockResolvedValue({ id: "s1" });
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await SeoOpportunityRetention.runDue(NOW)).toBe(0);
    expect(mocks.findingFindMany).not.toHaveBeenCalled();
  });
});
