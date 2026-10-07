import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: global iş yapılamayan süreçte veritabanına hiç
// gidilmez; bayraklar kapalıyken günde bir findFirst yapılır (satır yoksa
// başka sorgu yok, claimPeriodic yok) ve satır kalmışsa temizlik YİNE koşar;
// süresi 7 günden fazla dolmuş, iptali 7 günden eski ve raporu silinmiş
// SEARCH bağlantıları silinir.

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    reportShare: {
      findFirst: mocks.findFirst,
      deleteMany: mocks.deleteMany,
    },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

async function load() {
  vi.resetModules();
  return (await import("./retention")).ReportShareRetention;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("GSC_AGENCY", "true");
  vi.stubEnv("GA_AGENCY", "false");
  vi.stubEnv("NODE_ENV", "production");
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.findFirst.mockResolvedValue({ id: "s1" });
  mocks.deleteMany.mockResolvedValue({ count: 2 });
  mocks.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ReportShareRetention.runDue", () => {
  it("does nothing, without a database call, where global work is not allowed", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("with a flag on, claims the daily key and deletes expired, revoked and orphan shares", async () => {
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(5);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "report-share.retention",
      24 * 3_600_000,
      NOW,
    );
    expect(mocks.findFirst).not.toHaveBeenCalled();
    const cutoff = new Date(NOW.getTime() - 7 * DAY);
    expect(mocks.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: { expiresAt: { lt: cutoff } },
    });
    expect(mocks.deleteMany.mock.calls[1]?.[0]).toEqual({
      where: { revokedAt: { lt: cutoff } },
    });
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const sql = (mocks.executeRaw.mock.calls[0]?.[0] as string[]).join("");
    expect(sql).toContain('FROM "ReportShare"');
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain('"SeoReport"');
  });

  it("does nothing when the daily claim is taken", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("with both flags off, looks once per 24 hours and runs no other query when no row exists", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    mocks.findFirst.mockResolvedValue(null);
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();

    expect(await retention.runDue(new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);

    await retention.runDue(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("with both flags off, still cleans up when rows were left behind", async () => {
    vi.stubEnv("GSC_AGENCY", "false");
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(5);
    expect(mocks.claimPeriodic).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(2);
  });
});
