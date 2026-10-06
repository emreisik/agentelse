import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA-F4 saklaması bayraktan bağımsızdır: bayrak
// kapalıyken GaFinding satırı varsa yine silme yapılır, yoksa claim alınmaz;
// varlık sorgusu süreç başına günde birdir; canlı veritabanını paylaşan
// geliştirme süreci hiç çalıştırmaz.

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
  claimPeriodic: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gaFinding: { findFirst: mocks.findFirst, deleteMany: mocks.deleteMany },
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));

const { GaFindingRetention } = await import("./retention");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const REMOTE_DB =
  "postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/app";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  GaFindingRetention.resetIdleCheck();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("GA_INSIGHTS", "off");
  mocks.findFirst.mockResolvedValue(null);
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.deleteMany.mockResolvedValue({ count: 2 });
});

describe("GaFindingRetention.runWhileOff", () => {
  it("still deletes expired rows while findings remain", async () => {
    mocks.findFirst.mockResolvedValue({ id: "f1" });
    expect(await GaFindingRetention.runWhileOff(NOW)).toBe(2);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "ga.findings.retention",
      24 * 3_600_000,
      NOW,
    );
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("does nothing without findings and checks at most once a day", async () => {
    expect(await GaFindingRetention.runWhileOff(NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    await GaFindingRetention.runWhileOff(new Date(NOW.getTime() + 3_600_000));
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    await GaFindingRetention.runWhileOff(
      new Date(NOW.getTime() + 24 * 3_600_000),
    );
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it("never runs in the dev process sharing the live database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    mocks.findFirst.mockResolvedValue({ id: "f1" });
    expect(await GaFindingRetention.runWhileOff(NOW)).toBe(0);
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
