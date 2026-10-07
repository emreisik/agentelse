import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: 24 aylık silme, 90 günde before.contentRaw'ın
// null'lanması, terminal durumdan 30 gün sonra params.markdown'ın boşaltılması;
// dev süreci periyodik anahtar almaz; bayrak kapalıyken sorgusuz 0.

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
  claim: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoChange: { deleteMany: mocks.deleteMany },
    $executeRaw: mocks.executeRaw,
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claim,
}));

const { SeoApplyRetention } = await import("./retention");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 24 * 3_600_000;

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_APPLY", "true");
  vi.stubEnv("SEO_HEALTH", "true");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.claim.mockResolvedValue(true);
  mocks.deleteMany.mockResolvedValue({ count: 3 });
  mocks.executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(5);
});

describe("SeoApplyRetention.runDue", () => {
  it("returns 0 without any query while SEO_APPLY is off", async () => {
    vi.unstubAllEnvs();
    expect(await SeoApplyRetention.runDue(NOW)).toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it("a dev process sharing the live database claims nothing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com/live");
    expect(await SeoApplyRetention.runDue(NOW)).toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("does nothing when another process holds the daily claim", async () => {
    mocks.claim.mockResolvedValue(false);
    expect(await SeoApplyRetention.runDue(NOW)).toBe(0);
    expect(mocks.claim).toHaveBeenCalledWith(
      "seo.apply-retention",
      24 * 3_600_000,
      NOW,
    );
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes terminal rows older than 24 months only", async () => {
    await SeoApplyRetention.runDue(NOW);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["VERIFIED", "FAILED", "UNDONE", "REJECTED", "EXPIRED"] },
        createdAt: { lt: new Date(NOW.getTime() - 730 * DAY) },
      },
    });
  });

  it("nulls contentRaw after 90 days and blanks markdown after 30 days", async () => {
    const total = await SeoApplyRetention.runDue(NOW);
    expect(total).toBe(3 + 2 + 5);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(2);

    const [rawStrings, ...rawValues] = mocks.executeRaw.mock.calls[0] as [
      string[],
      ...unknown[],
    ];
    const rawSql = rawStrings.join("?");
    expect(rawSql).toContain("'{contentRaw}'");
    expect(rawSql).toContain("'APPLYING', 'APPLIED', 'UNDOING'");
    expect(rawValues).toEqual([new Date(NOW.getTime() - 90 * DAY)]);

    const [mdStrings, ...mdValues] = mocks.executeRaw.mock.calls[1] as [
      string[],
      ...unknown[],
    ];
    const mdSql = mdStrings.join("?");
    expect(mdSql).toContain("'{markdown}'");
    expect(mdSql).toContain("'VERIFIED', 'FAILED', 'UNDONE', 'REJECTED', 'EXPIRED'");
    expect(mdSql).toContain(`"kind" = 'PUBLISH_ARTICLE'`);
    expect(mdValues).toEqual([new Date(NOW.getTime() - 30 * DAY)]);
  });
});
