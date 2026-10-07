import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: geliştirme süreci canlı veritabanını paylaşırken
// saklama hiçbir sorgu yapmaz; bayrak kapalıyken ve satır yokken 24 saat içinde
// tek bir varlık sorgusu yapılır ve claimPeriodic'e gidilmez; satır varsa (bayrak
// kapalı olsa da) 36 ay ve bağı kalmayan satır temizliği çalışır.

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  claimPeriodic: vi.fn(),
  forgetForLinks: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: { findFirst: mocks.findFirst, deleteMany: mocks.deleteMany },
    $executeRaw: mocks.executeRaw,
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("./forget", () => ({
  forgetSeoActionsForLinks: mocks.forgetForLinks,
}));

import { SeoActionRetention } from "./retention";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_ACTIONS",
  "SEO_HEALTH",
  "SEO_CRAWL",
  "NODE_ENV",
  "DATABASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetAllMocks();
  SeoActionRetention.resetMemo();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env.SEO_ACTIONS;
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.deleteMany.mockResolvedValue({ count: 2 });
  mocks.executeRaw.mockResolvedValue(1);
  mocks.queryRaw.mockResolvedValue([{ linkId: "gone-link" }]);
  mocks.forgetForLinks.mockResolvedValue({ actions: 3, learnings: 1 });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else (process.env as Record<string, string | undefined>)[key] = saved[key];
  }
});

describe("SeoActionRetention", () => {
  it("does nothing in a development process that shares a live database", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV =
      "development";
    process.env.DATABASE_URL = "postgresql://user:pw@db.example.com/prod";
    expect(await SeoActionRetention.runDue(NOW)).toBe(0);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  });

  it("checks for rows once per day while the flag is off and stays idle without rows", async () => {
    mocks.findFirst.mockResolvedValue(null);
    expect(await SeoActionRetention.runDue(NOW)).toBe(0);
    expect(
      await SeoActionRetention.runDue(new Date(NOW.getTime() + 3_600_000)),
    ).toBe(0);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    await SeoActionRetention.runDue(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("still cleans up after the flag was turned off when rows remain", async () => {
    mocks.findFirst.mockResolvedValue({ id: "a1" });
    const deleted = await SeoActionRetention.runDue(NOW);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "seo.actions-retention",
      86_400_000,
      NOW,
    );
    // 2 (eski terminal) + 1 (silinmiş proje) + 3 + 1 (bağı kalmayan)
    expect(deleted).toBe(2 + 1 + 3 + 1);
    expect(mocks.forgetForLinks).toHaveBeenCalledWith(["gone-link"]);
  });

  it("does not clean up when another process holds today's claim", async () => {
    process.env.SEO_ACTIONS = "true";
    process.env.SEO_HEALTH = "true";
    process.env.SEO_CRAWL = "true";
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await SeoActionRetention.runDue(NOW)).toBe(0);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
