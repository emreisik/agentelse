import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak/modül kapalıyken 0 ve prisma'ya hiç
// dokunulmaz; izin listesi boşsa 0; izin listesi dışındaki proje atlanır;
// yalnız "open" pencere planlar (erken/geç atlanır); autoPlan kapalıysa atlanır;
// ACTIVE satır atlanır; boş satır 24 saat sonra (AI_LIMIT bir sonraki yerel
// gün) yeniden değerlendirilir; retry sonucu önbelleğe alınır; sınır
// uygulanır; canlı DB'yi paylaşan geliştirme sürecinde mock bağ atlanır; süpürme
// plandan önce koşar; bir projenin hatası ötekileri durdurmaz ve log Google
// metni taşımaz.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  linkFindMany: vi.fn(),
  projectFindMany: vi.fn(),
  scheduleFindMany: vi.fn(),
  settingFindUnique: vi.fn(),
  planFindUnique: vi.fn(),
  create: vi.fn(),
  sweep: vi.fn(),
  modules: vi.fn(),
  mock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: { findMany: mocks.linkFindMany },
    project: { findMany: mocks.projectFindMany },
    projectSchedule: { findMany: mocks.scheduleFindMany },
    seoContentSetting: { findUnique: mocks.settingFindUnique },
    seoContentPlan: { findUnique: mocks.planFindUnique },
  },
}));
vi.mock("@/server/works/flag", () => ({ isModulesEnabled: mocks.modules }));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mock,
}));
vi.mock("./planner", () => ({ createMonthlyPlan: mocks.create }));
vi.mock("./sweep", () => ({ sweepStaleSlots: mocks.sweep }));
vi.mock("./cap-status", () => ({ safeTimezone: (tz: string) => tz }));

const { SeoContentPlans, __clearContentPlanMemo } = await import("./runner");

// 7 Ekim 2026 15:00 (İstanbul): ayın 7'si, "open".
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV_KEYS = [
  "SEO_CONTENT_PLAN",
  "GSC_SYNC",
  "SEO_INSIGHTS",
  "GSC_SEARCH_PAGE",
  "NODE_ENV",
  "DATABASE_URL",
  "GSC_SYNC_DEV_PROJECTS",
  "GSC_ROLLOUT_PROJECTS",
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

const ON = {
  SEO_CONTENT_PLAN: "true",
  GSC_SYNC: "true",
  SEO_INSIGHTS: "on",
  GSC_SEARCH_PAGE: "true",
  NODE_ENV: "test",
} as const;

function link(projectId: string, extra: Record<string, unknown> = {}) {
  return {
    id: `link-${projectId}`,
    projectId,
    workspaceId: "w1",
    isMock: false,
    isPrimary: true,
    lastWeeklyWeek: "2026-09-28",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __clearContentPlanMemo();
  mocks.order.length = 0;
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv(ON);
  mocks.modules.mockReturnValue(true);
  mocks.mock.mockReturnValue(false);
  mocks.linkFindMany.mockResolvedValue([link("p1")]);
  mocks.projectFindMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
  mocks.scheduleFindMany.mockResolvedValue([]);
  mocks.settingFindUnique.mockResolvedValue(null);
  mocks.planFindUnique.mockResolvedValue(null);
  mocks.sweep.mockImplementation(async () => {
    mocks.order.push("sweep");
    return { swept: 0 };
  });
  mocks.create.mockImplementation(async () => {
    mocks.order.push("create");
    return { status: "created", planId: "plan-1", slots: 4 };
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

function prismaTouched(): boolean {
  return [
    mocks.linkFindMany,
    mocks.projectFindMany,
    mocks.scheduleFindMany,
    mocks.settingFindUnique,
    mocks.planFindUnique,
  ].some((fn) => fn.mock.calls.length > 0);
}

describe("SeoContentPlans.runDue gates", () => {
  it("returns 0 with no prisma call when the flag is off", async () => {
    setEnv({ ...ON, SEO_CONTENT_PLAN: "false" });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(prismaTouched()).toBe(false);
  });

  it("returns 0 when one of the other flags is off", async () => {
    setEnv({ ...ON, GSC_SEARCH_PAGE: "false" });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(prismaTouched()).toBe(false);
  });

  it("returns 0 when modules are disabled", async () => {
    mocks.modules.mockReturnValue(false);
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(prismaTouched()).toBe(false);
  });

  it("returns 0 without a query when the allow-list is empty", async () => {
    // Geliştirme süreci, canlı DB, dev listesi boş.
    setEnv({
      ...ON,
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://u:p@db.example.com/prod",
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(prismaTouched()).toBe(false);
  });

  it("restricts the link query to the allow-list and skips projects outside it", async () => {
    setEnv({ ...ON, GSC_ROLLOUT_PROJECTS: "p1" });
    mocks.linkFindMany.mockResolvedValue([link("p2"), link("p1")]);
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
    expect(mocks.linkFindMany.mock.calls[0]?.[0].where.projectId).toEqual({
      in: ["p1"],
    });
    // Sorgu yanlışlıkla p2 döndürse bile proje başına kapı onu eler.
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[0].link.projectId).toBe("p1");
  });

  it("skips a mock link in a dev process sharing the live database", async () => {
    setEnv({
      ...ON,
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://u:p@db.example.com/prod",
      GSC_SYNC_DEV_PROJECTS: "p1",
    });
    mocks.mock.mockReturnValue(true);
    mocks.linkFindMany.mockResolvedValue([link("p1", { isMock: true })]);
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
  });

  it("skips a project that is not ACTIVE", async () => {
    mocks.projectFindMany.mockResolvedValue([]);
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("SeoContentPlans.runDue planning window", () => {
  it("plans in the open window with the project timezone and trigger auto", async () => {
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        month: "2026-10",
        timezone: "Europe/Istanbul",
        now: NOW,
        trigger: "auto",
      }),
    );
  });

  it("uses the project's own timezone to find the local month", async () => {
    // 31 Ekim 23:30 UTC = 1 Kasım 12:30 Pasifik/Auckland: yerel ay Kasım ve
    // erken pencere; İstanbul'da hâlâ 1 Kasım 02:30 (erken).
    mocks.scheduleFindMany.mockResolvedValue([
      { projectId: "p1", timezone: "Pacific/Auckland" },
    ]);
    expect(
      await SeoContentPlans.runDue(2, new Date("2026-10-31T23:30:00.000Z")),
    ).toBe(0);
    expect(mocks.sweep.mock.calls[0]?.[0].currentMonth).toBe("2026-11");
  });

  it("skips the early window (before the 2nd 09:00) after sweeping", async () => {
    // 2 Ekim 08:00 İstanbul.
    expect(
      await SeoContentPlans.runDue(2, new Date("2026-10-02T05:00:00.000Z")),
    ).toBe(0);
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.settingFindUnique).not.toHaveBeenCalled();
  });

  it("skips the closed window (last 7 days)", async () => {
    expect(
      await SeoContentPlans.runDue(2, new Date("2026-10-28T09:00:00.000Z")),
    ).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("skips when autoPlan is off and does not query the plan row", async () => {
    mocks.settingFindUnique.mockResolvedValue({
      monthlyCap: 4,
      autoPlan: false,
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.planFindUnique).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("sweeps stale slots before planning and only once per month", async () => {
    await SeoContentPlans.runDue(2, NOW);
    expect(mocks.order).toEqual(["sweep", "create"]);
    expect(mocks.sweep).toHaveBeenCalledWith({
      linkId: "link-p1",
      projectId: "p1",
      currentMonth: "2026-10",
      timezone: "Europe/Istanbul",
      now: NOW,
    });
    // Çözülmüş ay önbellekte: ikinci tick'te ne süpürme ne sorgu.
    mocks.sweep.mockClear();
    mocks.planFindUnique.mockClear();
    await SeoContentPlans.runDue(2, new Date(NOW.getTime() + 60_000));
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.planFindUnique).not.toHaveBeenCalled();
  });

  it("sweeps again when the local month changes", async () => {
    await SeoContentPlans.runDue(2, NOW);
    await SeoContentPlans.runDue(2, new Date("2026-11-03T12:00:00.000Z"));
    expect(mocks.sweep).toHaveBeenCalledTimes(2);
    expect(mocks.sweep.mock.calls[1]?.[0].currentMonth).toBe("2026-11");
  });
});

describe("SeoContentPlans.runDue existing rows", () => {
  it("skips a month whose plan is ACTIVE", async () => {
    mocks.planFindUnique.mockResolvedValue({
      status: "ACTIVE",
      data: {},
      updatedAt: NOW,
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rechecks an EMPTY NO_DATA row only after 24 hours", async () => {
    mocks.planFindUnique.mockResolvedValue({
      status: "EMPTY",
      data: { reason: "NO_DATA" },
      updatedAt: new Date(NOW.getTime() - 23 * 3_600_000),
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();

    __clearContentPlanMemo();
    mocks.planFindUnique.mockResolvedValue({
      status: "EMPTY",
      data: { reason: "NO_DATA" },
      updatedAt: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("rechecks an AI_LIMIT row from the next local day", async () => {
    // Satır bugün (İstanbul) yazıldı: bekler.
    mocks.planFindUnique.mockResolvedValue({
      status: "EMPTY",
      data: { reason: "AI_LIMIT" },
      updatedAt: new Date("2026-10-07T03:00:00.000Z"),
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();

    // Dün yazıldı: yeniden denenir.
    __clearContentPlanMemo();
    mocks.planFindUnique.mockResolvedValue({
      status: "EMPTY",
      data: { reason: "AI_LIMIT" },
      updatedAt: new Date("2026-10-06T10:00:00.000Z"),
    });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
  });

  it("treats CAP_FULL, NO_ROOM and ALL_FILTERED rows as settled", async () => {
    for (const reason of ["CAP_FULL", "NO_ROOM", "ALL_FILTERED"]) {
      __clearContentPlanMemo();
      mocks.planFindUnique.mockResolvedValue({
        status: "EMPTY",
        data: { reason },
        updatedAt: new Date(NOW.getTime() - 72 * 3_600_000),
      });
      expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("SeoContentPlans.runDue outcomes and limit", () => {
  it("memoises a retry outcome so the next tick does not call the planner", async () => {
    mocks.create.mockResolvedValue({ status: "retry", reason: "BUDGET" });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(await SeoContentPlans.runDue(2, new Date(NOW.getTime() + 60_000))).toBe(
      0,
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    // 1 saat sonra yeniden denenir.
    await SeoContentPlans.runDue(2, new Date(NOW.getTime() + 61 * 60_000));
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("retries a BUSY outcome sooner than a budget retry", async () => {
    mocks.create.mockResolvedValue({ status: "retry", reason: "BUSY" });
    await SeoContentPlans.runDue(2, NOW);
    await SeoContentPlans.runDue(2, new Date(NOW.getTime() + 11 * 60_000));
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it("counts empty outcomes and ignores exists", async () => {
    mocks.linkFindMany.mockResolvedValue([link("p1"), link("p2")]);
    mocks.create
      .mockResolvedValueOnce({ status: "empty", reason: "NO_DATA" })
      .mockResolvedValueOnce({ status: "exists" });
    expect(await SeoContentPlans.runDue(5, NOW)).toBe(1);
  });

  it("plans at most `limit` projects per tick", async () => {
    mocks.linkFindMany.mockResolvedValue([
      link("p1"),
      link("p2"),
      link("p3"),
    ]);
    mocks.projectFindMany.mockResolvedValue([
      { id: "p1" },
      { id: "p2" },
      { id: "p3" },
    ]);
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(2);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    // Üçüncüsü bir sonraki tick'te.
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(3);
  });

  it("a failing project does not stop the others and the log carries no message", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.linkFindMany.mockResolvedValue([link("p1"), link("p2")]);
    mocks.create
      .mockRejectedValueOnce(new Error("query: best running shoes 2026"))
      .mockResolvedValueOnce({ status: "created", planId: "x", slots: 3 });
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(1);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain("running shoes");
    expect(logged).toContain("p1");
    errors.mockRestore();
  });

  it("a failing sweep is isolated and retried on the next tick", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.sweep.mockRejectedValueOnce(new Error("boom"));
    expect(await SeoContentPlans.runDue(2, NOW)).toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
    // Başarısızlık 10 dakika sonra yeniden denenir ve süpürme yeniden koşar.
    expect(
      await SeoContentPlans.runDue(2, new Date(NOW.getTime() + 11 * 60_000)),
    ).toBe(1);
    expect(mocks.sweep).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });
});
