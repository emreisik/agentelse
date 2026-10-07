import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı (GA-F8 ga-bigquery tick adımı): bayrak ve geliştirme
// koruması kapıları (kapalıyken hiç sorgu yok), yalnız vadesi gelmiş ve bağı
// sağlıklı birincil/ek mülk olan kaynaklar seçilir, en eski vadeden başlanır,
// tick başına en çok `limit` kaynak okunur.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  claimPeriodic: vi.fn(),
  syncSource: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gaBigQuerySource: { findMany: mocks.findMany } },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("./reader", () => ({ GaBigQuery: { syncSource: mocks.syncSource } }));

const { GaBigQueryRunner } = await import("./runner");

const NOW = new Date("2026-10-07T10:00:00Z");

beforeEach(() => {
  vi.stubEnv("GA_AGENCY", "true");
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_BIGQUERY", "true");
  vi.stubEnv("NODE_ENV", "test");
  mocks.findMany.mockReset().mockResolvedValue([]);
  mocks.claimPeriodic.mockReset().mockResolvedValue(true);
  mocks.syncSource.mockReset().mockResolvedValue("synced");
});
afterEach(() => vi.unstubAllEnvs());

describe("GaBigQueryRunner gates", () => {
  it.each([
    ["GA_BIGQUERY", "false"],
    ["GA_AGENCY", "false"],
    ["GA_SYNC", "false"],
  ])("returns 0 without any query when %s is %s", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("does nothing when the periodic lock is held", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(0);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith("ga.bigquery", 10 * 60_000, NOW);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("does nothing in a dev process sharing the live database without an allow-list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(0);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("restricts a dev process to the allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@ep-live.neon.tech/db");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "proj1, proj2");
    mocks.findMany.mockResolvedValue([
      { id: "a", projectId: "proj1" },
      { id: "b", projectId: "proj9" },
    ]);
    await GaBigQueryRunner.runDue(2, NOW);
    expect(mocks.findMany.mock.calls[0]![0].where.projectId).toEqual({
      in: ["proj1", "proj2"],
    });
    // Sorgu filtresini atlayan bir satır bile ikinci kez elenir.
    expect(mocks.syncSource.mock.calls.map((call) => call[0])).toEqual(["a"]);
  });
});

describe("GaBigQueryRunner selection", () => {
  it("selects due, healthy primary or secondary sources oldest first", async () => {
    await GaBigQueryRunner.runDue(2, NOW);
    const query = mocks.findMany.mock.calls[0]![0];
    expect(query.where.status).toEqual({ in: ["OK", "PENDING", "ERROR"] });
    expect(query.where.nextRunAt).toEqual({ lte: NOW });
    expect(query.where.link).toEqual({
      OR: [{ isPrimary: true }, { isSecondary: true }],
      health: "OK",
    });
    expect(query.orderBy).toEqual({ nextRunAt: "asc" });
    expect(query.take).toBe(6);
  });

  it("reads at most `limit` sources and counts the ones that did work", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a", projectId: "p" },
      { id: "b", projectId: "p" },
      { id: "c", projectId: "p" },
    ]);
    mocks.syncSource
      .mockResolvedValueOnce("skipped")
      .mockResolvedValueOnce("synced")
      .mockResolvedValueOnce("error");
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(2);
    expect(mocks.syncSource).toHaveBeenCalledTimes(3);
    expect(mocks.syncSource.mock.calls[0]).toEqual(["a", NOW]);
  });

  it("stops after `limit` sources worked", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a", projectId: "p" },
      { id: "b", projectId: "p" },
      { id: "c", projectId: "p" },
    ]);
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(2);
    expect(mocks.syncSource).toHaveBeenCalledTimes(2);
  });

  it("survives a source that throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.findMany.mockResolvedValue([
      { id: "a", projectId: "p" },
      { id: "b", projectId: "p" },
    ]);
    mocks.syncSource.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("synced");
    expect(await GaBigQueryRunner.runDue(2, NOW)).toBe(1);
    spy.mockRestore();
  });
});
