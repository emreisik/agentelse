import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: global iş yapılamayan süreçte (canlı DB paylaşan
// geliştirme) veritabanına hiç gidilmez; bayrak kapalı ve rapor verisi yokken
// tek varlık sorgusu yapılır ve 24 saat içinde ikincisi yapılmaz; veri
// kaldıysa temizlik koşar; archive=false bağlarında 487 gün, nabızda 90 gün,
// diğerlerinde 1096 gün; hedef değeri boşaltan SQL beş anahtarı parametre
// olarak alır.

const mocks = vi.hoisted(() => ({
  reportFindFirst: vi.fn(),
  progressFindFirst: vi.fn(),
  reportDeleteMany: vi.fn(),
  executeRaw: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoReport: {
      findFirst: mocks.reportFindFirst,
      deleteMany: mocks.reportDeleteMany,
    },
    seoGoalProgress: { findFirst: mocks.progressFindFirst },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

// Süreç içi bellek testler arasında sıfırlansın diye modül her testte yeniden
// yüklenir.
async function load() {
  vi.resetModules();
  return (await import("./retention")).SeoReportRetention;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.reportFindFirst.mockResolvedValue({ id: "r" });
  mocks.progressFindFirst.mockResolvedValue(null);
  mocks.reportDeleteMany.mockResolvedValue({ count: 2 });
  mocks.executeRaw.mockResolvedValue(1);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SeoReportRetention.runDue", () => {
  it("does nothing, without a database call, where global work is not allowed", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.reportFindFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  });

  it("looks for leftovers once per 24 hours when the flag is off and none exist", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    mocks.reportFindFirst.mockResolvedValue(null);
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.progressFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();

    expect(await retention.runDue(new Date(NOW.getTime() + 3_600_000))).toBe(0);
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.progressFindFirst).toHaveBeenCalledTimes(1);

    await retention.runDue(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(2);
  });

  it("still cleans up with the flag off when report data is left", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    const retention = await load();
    expect(await retention.runDue(NOW)).toBeGreaterThan(0);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "seo.reports-retention",
      24 * 3_600_000,
      NOW,
    );
  });

  it("looks for leftovers only once per 24 hours when data is left and the flag is off", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    const retention = await load();
    await retention.runDue(NOW);
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).toHaveBeenCalledTimes(1);

    await retention.runDue(new Date(NOW.getTime() + 3_600_000));
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).toHaveBeenCalledTimes(1);

    await retention.runDue(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(mocks.reportFindFirst).toHaveBeenCalledTimes(2);
  });

  it("finds leftover goal progress when no report is left", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    mocks.reportFindFirst.mockResolvedValue(null);
    mocks.progressFindFirst.mockResolvedValue({ id: "p" });
    const retention = await load();
    await retention.runDue(NOW);
    expect(mocks.claimPeriodic).toHaveBeenCalled();
  });

  it("does nothing when the daily claim is taken", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    const retention = await load();
    expect(await retention.runDue(NOW)).toBe(0);
    expect(mocks.reportDeleteMany).not.toHaveBeenCalled();
  });

  it("deletes pulses after 90 days, reports after 1096 and 16-month links after 487", async () => {
    const retention = await load();
    const total = await retention.runDue(NOW);
    expect(total).toBe(2 + 2 + 2 + 1 + 1);

    const [pulse, reports, archiveOff] = mocks.reportDeleteMany.mock.calls.map(
      (call) => call[0].where,
    );
    expect(pulse.kind).toBe("PULSE");
    expect(pulse.createdAt.lt).toEqual(new Date(NOW.getTime() - 90 * DAY));
    expect(reports.kind).toEqual({ not: "PULSE" });
    expect(reports.createdAt.lt).toEqual(new Date(NOW.getTime() - 1096 * DAY));
    expect(archiveOff.kind).toEqual({ not: "PULSE" });
    expect(archiveOff.createdAt.lt).toEqual(
      new Date(NOW.getTime() - 487 * DAY),
    );
    expect(archiveOff.link).toEqual({ archive: false });
  });

  it("nulls SEO goal values with the five exact metric keys as parameters", async () => {
    const retention = await load();
    await retention.runDue(NOW);
    const calls = mocks.executeRaw.mock.calls as [
      TemplateStringsArray,
      ...unknown[],
    ][];
    expect(calls).toHaveLength(2);
    const [, update] = calls;
    const sql = update![0].join("?");
    expect(sql).toContain('UPDATE "ProjectGoal"');
    expect(sql).toContain('"currentValue" = NULL');
    expect(sql).toContain('FROM "GscSiteLink"');
    expect(sql).toContain('"isMock" = g."isMock"');
    const values = update!.slice(1).flatMap((value) =>
      // Prisma.join bir Sql nesnesidir; parametreleri .values'ta.
      value && typeof value === "object" && "values" in value
        ? (value as { values: unknown[] }).values
        : [value],
    );
    expect(values).toEqual([
      "gsc.nonBrandClicks",
      "gsc.clicks",
      "gsc.top10Queries",
      "seo.indexedShare",
      "seo.cwvGoodShare",
    ]);
  });

  it("removes goal progress whose goal is no longer active or approved", async () => {
    const retention = await load();
    await retention.runDue(NOW);
    const [first] = mocks.executeRaw.mock.calls as [TemplateStringsArray][];
    const sql = first![0].join("?");
    expect(sql).toContain('DELETE FROM "SeoGoalProgress"');
    expect(sql).toContain("'ACTIVE', 'APPROVED'");
  });
});
