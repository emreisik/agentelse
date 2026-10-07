import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: geliştirme süreci (canlı DB paylaşılırken) hiç
// çalıştırmaz; bayrak kapalı ve plan satırı yoksa 0 (claimPeriodic alınmaz, varlık
// sorgusu 24 saatte bir); bayrak kapalı ama satır kaldıysa çalışır; kilit
// alınamazsa 0; 14 aylık sınırdan eski satırlar önce forget'ten geçer; sınırdaki
// ay silinmez.

const mocks = vi.hoisted(() => ({
  planFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  claimPeriodic: vi.fn(),
  forgetRows: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoContentPlan: {
      findFirst: mocks.planFindFirst,
      findMany: mocks.planFindMany,
    },
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("./forget", () => ({ forgetSeoContentPlanRows: mocks.forgetRows }));

const { SeoContentPlanRetention, retentionCutoffMonth } = await import(
  "./retention"
);

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "NODE_ENV",
  "DATABASE_URL",
] as const;
const saved: Record<string, string | undefined> = {};
const env = process.env as Record<string, string | undefined>;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

const OFF = { NODE_ENV: "test" } as const;
const ON = {
  SEO_CONTENT_PLAN: "true",
  GSC_SYNC: "true",
  SEO_INSIGHTS: "on",
  GSC_SEARCH_PAGE: "true",
  NODE_ENV: "test",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  SeoContentPlanRetention.resetIdleCheck();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv(OFF);
  mocks.planFindFirst.mockResolvedValue(null);
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.planFindMany.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
  mocks.planFindMany.mockResolvedValue([]);
  mocks.forgetRows.mockResolvedValue({ plans: 2, slotsRemoved: 5, ideas: 3 });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

describe("retentionCutoffMonth", () => {
  it("is the month 14 months back; older months are removed", () => {
    expect(retentionCutoffMonth(NOW)).toBe("2025-08");
    expect(retentionCutoffMonth(new Date("2026-02-15T00:00:00Z"))).toBe(
      "2024-12",
    );
    expect(retentionCutoffMonth(new Date("2026-03-01T00:00:00Z"))).toBe(
      "2025-01",
    );
  });
});

describe("SeoContentPlanRetention.runDue", () => {
  it("does nothing when the flag is off and no plan row exists", async () => {
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.forgetRows).not.toHaveBeenCalled();
  });

  it("probes for plan rows at most once per 24 hours while the flag is off", async () => {
    await SeoContentPlanRetention.runDue(NOW);
    await SeoContentPlanRetention.runDue(new Date(NOW.getTime() + 3_600_000));
    expect(mocks.planFindFirst).toHaveBeenCalledTimes(1);
    await SeoContentPlanRetention.runDue(new Date(NOW.getTime() + 25 * 3_600_000));
    expect(mocks.planFindFirst).toHaveBeenCalledTimes(2);
  });

  it("still runs with the flag off when a plan row remains", async () => {
    mocks.planFindFirst.mockResolvedValue({ id: "x" });
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(2);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "seo.content-plan-retention",
      86_400_000,
      NOW,
    );
  });

  it("with the flag off and a plan row left, runs the lock query once per 24 hours too", async () => {
    mocks.planFindFirst.mockResolvedValue({ id: "x" });
    await SeoContentPlanRetention.runDue(NOW);
    await SeoContentPlanRetention.runDue(new Date(NOW.getTime() + 3_600_000));
    await SeoContentPlanRetention.runDue(new Date(NOW.getTime() + 7_200_000));
    expect(mocks.planFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.claimPeriodic).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when the shared lock is not claimed", async () => {
    setEnv(ON);
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(0);
    expect(mocks.planFindMany).not.toHaveBeenCalled();
    expect(mocks.forgetRows).not.toHaveBeenCalled();
  });

  it("never runs in a dev process sharing the live database", async () => {
    setEnv({
      ...ON,
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://u:p@db.example.com/prod",
    });
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(0);
    expect(mocks.planFindFirst).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  });

  it("forgets rows older than the cut-off first and reports the deleted plans", async () => {
    setEnv(ON);
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(2);
    expect(mocks.planFindMany).toHaveBeenCalledWith({
      where: { month: { lt: "2025-08" } },
      select: { id: true },
      take: 200,
    });
    expect(mocks.forgetRows).toHaveBeenCalledWith(["a", "b"]);
    // forget, silmeden önce bulunan satırlar için çağrılır; ek bir plan silme
    // sorgusu yok (forget satırı kendisi siler).
    expect(mocks.planFindMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.forgetRows.mock.invocationCallOrder[0]!,
    );
  });

  it("does nothing more when there are no old rows", async () => {
    setEnv(ON);
    mocks.planFindMany.mockReset();
    mocks.planFindMany.mockResolvedValue([]);
    expect(await SeoContentPlanRetention.runDue(NOW)).toBe(0);
    expect(mocks.forgetRows).not.toHaveBeenCalled();
  });
});
