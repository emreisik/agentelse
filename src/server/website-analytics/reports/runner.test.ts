import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_REPORTS ya da GA_SYNC kapalıyken ve canlı
// veritabanını paylaşan geliştirme sürecinde liste boşken runDue hiçbir
// sorgu yapmadan 0 döner; adaylar önce hiç GaReportRun'ı olmayan bağlar, sonra
// lastCheckedAt'e göre en eskiler (bellek içi tavan yok); kilit alınamazsa
// "busy"; LLM bütçesi yalnız modelin gerçekten çağrıldığı durumlarda
// düşer (mock anlatı düşürmez), bütçe bitince yazar "defer" kipiyle çağrılır
// ve ertelenen hafta işaretlenmez; iki başarısız denemeden sonra üçüncü
// çağrı "skip" kipindedir, beşinci denemede hafta işaretlenip atlanan olarak
// sayılır ve lastError yalnız hata adını taşır.

const db = vi.hoisted(() => ({
  gaPropertyLink: { findMany: vi.fn(), findUnique: vi.fn() },
  gaReportRun: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  },
}));
const deps = vi.hoisted(() => ({
  claimPeriodic: vi.fn(),
  heartbeatOk: vi.fn(),
  retentionRunDue: vi.fn(),
  refreshLink: vi.fn(),
  loadGaReportContext: vi.fn(),
  historyDaysOf: vi.fn(),
  insightsProgressOf: vi.fn(),
  weeklyWrite: vi.fn(),
  monthlyWrite: vi.fn(),
  writePlan: vi.fn(),
  pulseWrite: vi.fn(),
  postAlertCards: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: deps.claimPeriodic,
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { ok: deps.heartbeatOk },
}));
vi.mock("./retention", () => ({
  GaReportRetention: { runDue: deps.retentionRunDue },
}));
vi.mock("./goals", () => ({ GaGoals: { refreshLink: deps.refreshLink } }));
vi.mock("./inputs", () => ({
  loadGaReportContext: deps.loadGaReportContext,
  historyDaysOf: deps.historyDaysOf,
  insightsProgressOf: deps.insightsProgressOf,
}));
vi.mock("./weekly", () => ({ GaWeeklyReport: { write: deps.weeklyWrite } }));
vi.mock("./monthly", () => ({
  GaMonthlyReport: { write: deps.monthlyWrite, writePlan: deps.writePlan },
}));
vi.mock("./pulse", () => ({
  GaPulse: { write: deps.pulseWrite, postAlertCards: deps.postAlertCards },
}));

const { GaReports } = await import("./runner");

const REMOTE_DB =
  "postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/app";
// Pazartesi 2026-10-12 08:30 İstanbul; geçen hafta (5 Ekim) vadeli.
const NOW = new Date("2026-10-12T05:30:00.000Z");
const WEEK_ID = "weekly:2026-10-05";

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  isPrimary: true,
  isMock: false,
};

function settings(partial: Record<string, unknown> = {}) {
  return {
    weeklyEnabled: true,
    weeklyWeekday: 1,
    monthlyEnabled: false,
    monthlyDay: 2,
    pulse: "off",
    alertChat: false,
    alertTelegram: true,
    stored: true,
    ...partial,
  };
}

function context(partial: Record<string, unknown> = {}) {
  return {
    link: LINK,
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    projectTimeZone: "Europe/Istanbul",
    propertyTimeZone: "Europe/Istanbul",
    propertyToday: "2026-10-12",
    localNow: "2026-10-12T08:30",
    completeThrough: "2026-10-11",
    settings: settings(),
    insights: "off",
    websitePage: false,
    country: null,
    now: NOW,
    ...partial,
  };
}

function run(partial: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    linkId: "link-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    leaseUntil: null,
    leaseOwner: null,
    lastCheckedAt: null,
    lastPulseDay: null,
    lastPulseAt: null,
    pulsePendingDay: null,
    pulsePendingSince: null,
    lastWeek: null,
    lastMonth: null,
    lastPlanMonth: null,
    lastGoalsDay: null,
    lastAlertScanAt: null,
    attempts: null,
    lastError: null,
    stats: null,
    ...partial,
  };
}

function allMocks() {
  return [
    ...Object.values(db).flatMap((model) => Object.values(model)),
    ...Object.values(deps),
  ];
}

function savedData(): Record<string, unknown> {
  const call = db.gaReportRun.update.mock.calls[0];
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of allMocks()) mock.mockReset();
  vi.stubEnv("GA_REPORTS", "true");
  vi.stubEnv("GA_SYNC", "true");
  db.gaPropertyLink.findMany.mockResolvedValue([]);
  db.gaPropertyLink.findUnique.mockResolvedValue(LINK);
  db.gaReportRun.upsert.mockResolvedValue(run());
  db.gaReportRun.findMany.mockResolvedValue([]);
  db.gaReportRun.findUniqueOrThrow.mockResolvedValue(run());
  db.gaReportRun.updateMany.mockResolvedValue({ count: 1 });
  db.gaReportRun.update.mockResolvedValue(run());
  deps.claimPeriodic.mockResolvedValue(true);
  deps.retentionRunDue.mockResolvedValue(0);
  deps.refreshLink.mockResolvedValue(0);
  deps.loadGaReportContext.mockResolvedValue(context());
  deps.historyDaysOf.mockResolvedValue(400);
  deps.insightsProgressOf.mockResolvedValue({
    lastWeek: null,
    lastDailyDay: null,
  });
  deps.weeklyWrite.mockResolvedValue({ result: "posted", narrative: null });
  deps.writePlan.mockResolvedValue("posted");
});

describe("GaReports.runDue (gates)", () => {
  it("returns 0 without any query when GA_REPORTS is unset", async () => {
    vi.stubEnv("GA_REPORTS", "");
    expect(await GaReports.runDue(5, NOW)).toBe(0);
    for (const mock of allMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("returns 0 without any query when GA_SYNC is unset", async () => {
    vi.stubEnv("GA_SYNC", "");
    expect(await GaReports.runDue(5, NOW)).toBe(0);
    for (const mock of allMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("returns 0 without any query for a dev process with an empty list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await GaReports.runDue(5, NOW)).toBe(0);
    for (const mock of allMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("returns 0 when another process claimed the tick", async () => {
    deps.claimPeriodic.mockResolvedValue(false);
    expect(await GaReports.runDue(5, NOW)).toBe(0);
    expect(deps.claimPeriodic).toHaveBeenCalledWith(
      "ga.reports.tick",
      5 * 60_000,
      NOW,
    );
    expect(db.gaPropertyLink.findMany).not.toHaveBeenCalled();
  });

  it("scopes a dev process to its listed projects and writes no heartbeat", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", " proj-a , proj-b ");
    // Süreç içi kısma: ilk çağrı geçer, hemen ardından ikincisi geçmez.
    const later = new Date(NOW.getTime() + 10 * 3_600_000);
    expect(await GaReports.runDue(5, later)).toBe(0);
    const where = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: { projectId: { in: string[] } };
    };
    expect(where.where.projectId).toEqual({ in: ["proj-a", "proj-b"] });
    expect(deps.claimPeriodic).not.toHaveBeenCalled();
    expect(deps.retentionRunDue).not.toHaveBeenCalled();
    expect(deps.heartbeatOk).not.toHaveBeenCalled();
    expect(await GaReports.runDue(5, new Date(later.getTime() + 60_000))).toBe(
      0,
    );
    expect(db.gaPropertyLink.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("GaReports.runDue (candidates)", () => {
  it("takes links without a run first, then the least recently checked", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    db.gaReportRun.findMany.mockResolvedValue([
      { linkId: "c" },
      { linkId: "a" },
    ]);
    // Her bağ kilitlenemez: yalnız çağrı sırası sınanır.
    db.gaReportRun.updateMany.mockResolvedValue({ count: 0 });
    await GaReports.runDue(4, NOW);

    const fresh = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(fresh.where).toMatchObject({
      isPrimary: true,
      lastDailyDate: { not: null },
      reportRun: null,
    });
    expect(fresh.take).toBe(4);
    const seen = db.gaReportRun.findMany.mock.calls[0]?.[0] as {
      orderBy: unknown;
      take: number;
    };
    expect(seen.orderBy).toEqual({
      lastCheckedAt: { sort: "asc", nulls: "first" },
    });
    expect(seen.take).toBe(2);
    const order = db.gaPropertyLink.findUnique.mock.calls.map(
      (call) => (call[0] as { where: { id: string } }).where.id,
    );
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("skips the second query when fresh links fill the limit", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    await GaReports.runDue(2, NOW);
    expect(db.gaReportRun.findMany).not.toHaveBeenCalled();
  });

  it("writes the heartbeat and counts processed links", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "link-1" }]);
    expect(await GaReports.runDue(5, NOW)).toBe(1);
    expect(deps.heartbeatOk).toHaveBeenCalledWith("ga.reports", NOW);
    expect(deps.retentionRunDue).toHaveBeenCalledWith(NOW);
  });
});

describe("GaReports.runLink", () => {
  it("is skipped when the link is gone or not primary", async () => {
    db.gaPropertyLink.findUnique.mockResolvedValue(null);
    expect(await GaReports.runLink("missing", { now: NOW })).toBe("skipped");
    db.gaPropertyLink.findUnique.mockResolvedValue({
      ...LINK,
      isPrimary: false,
    });
    expect(await GaReports.runLink("link-1", { now: NOW })).toBe("skipped");
    expect(db.gaReportRun.upsert).not.toHaveBeenCalled();
  });

  it("returns busy when the lease is not claimed", async () => {
    db.gaReportRun.updateMany.mockResolvedValue({ count: 0 });
    expect(await GaReports.runLink("link-1", { now: NOW })).toBe("busy");
    expect(deps.loadGaReportContext).not.toHaveBeenCalled();
    expect(deps.weeklyWrite).not.toHaveBeenCalled();
  });

  it("releases the lease and skips when the project is paused", async () => {
    deps.loadGaReportContext.mockResolvedValue(null);
    expect(await GaReports.runLink("link-1", { now: NOW })).toBe("skipped");
    const release = db.gaReportRun.updateMany.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(release.data).toEqual({ leaseUntil: null, leaseOwner: null });
  });

  it("posts the weekly report, marks the week and refreshes goals once", async () => {
    deps.weeklyWrite.mockResolvedValue({ result: "posted", narrative: null });
    const result = await GaReports.runLink("link-1", { now: NOW });
    expect(result).toMatchObject({ weekly: "posted", llmCalls: 0 });
    expect(deps.refreshLink).toHaveBeenCalledTimes(1);
    expect(deps.weeklyWrite).toHaveBeenCalledWith(
      expect.anything(),
      { monday: "2026-10-05", sunday: "2026-10-11" },
      "off",
      { narrative: "allow" },
    );
    expect(savedData()).toMatchObject({
      lastWeek: "2026-10-05",
      lastGoalsDay: "2026-10-11",
      lastError: null,
    });
  });

  it("does not post a weekly report that is already marked", async () => {
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ lastWeek: "2026-10-05", lastGoalsDay: "2026-10-11" }),
    );
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.weeklyWrite).not.toHaveBeenCalled();
    expect(deps.refreshLink).not.toHaveBeenCalled();
  });

  it("posts nothing when weekly reports are switched off", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({ settings: settings({ weeklyEnabled: false }) }),
    );
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.weeklyWrite).not.toHaveBeenCalled();
  });
});

describe("GaReports.runLink (LLM budget)", () => {
  it("does not spend budget on a mock narrative", async () => {
    deps.weeklyWrite.mockResolvedValue({ result: "posted", narrative: "mock" });
    const result = await GaReports.runLink("link-1", {
      now: NOW,
      llmBudget: 1,
    });
    expect(result).toMatchObject({ llmCalls: 0 });
  });

  it.each(["ok", "dropped", "budget", "error"] as const)(
    "counts a %s narrative as an LLM call",
    async (status) => {
      deps.weeklyWrite.mockResolvedValue({
        result: "posted",
        narrative: status,
      });
      const result = await GaReports.runLink("link-1", {
        now: NOW,
        llmBudget: 1,
      });
      expect(result).toMatchObject({ llmCalls: 1 });
    },
  );

  it("defers with no budget left and leaves the week unmarked", async () => {
    deps.weeklyWrite.mockResolvedValue({
      result: "deferred",
      narrative: null,
    });
    const result = await GaReports.runLink("link-1", {
      now: NOW,
      llmBudget: 0,
    });
    expect(deps.weeklyWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "off",
      { narrative: "defer" },
    );
    expect(result).toMatchObject({ weekly: "deferred", llmCalls: 0 });
    expect(savedData()).not.toHaveProperty("lastWeek");
  });

  it("passes the remaining budget on to the monthly report", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({
        settings: settings({ monthlyEnabled: true }),
        localNow: "2026-11-02T08:30",
        propertyToday: "2026-11-02",
        completeThrough: "2026-11-01",
      }),
    );
    deps.monthlyWrite.mockResolvedValue({
      result: "deferred",
      narrative: null,
    });
    deps.weeklyWrite.mockResolvedValue({ result: "posted", narrative: "ok" });
    await GaReports.runLink("link-1", { now: NOW, llmBudget: 1 });
    expect(deps.monthlyWrite).toHaveBeenCalledWith(
      expect.anything(),
      "2026-10",
      "off",
      { narrative: "defer" },
    );
  });
});

describe("GaReports.runLink (failures)", () => {
  it("uses skip mode from the third attempt on", async () => {
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ attempts: { [WEEK_ID]: 2 } }),
    );
    await GaReports.runLink("link-1", { now: NOW, llmBudget: 2 });
    expect(deps.weeklyWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "off",
      { narrative: "skip" },
    );
    // Başarıyla yazıldı: sayaç temizlenir.
    expect(savedData().attempts).toEqual({});
  });

  it("counts a failed attempt and records only the error name", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    deps.weeklyWrite.mockRejectedValue(
      new TypeError("/secret-page?q=private text"),
    );
    const result = await GaReports.runLink("link-1", { now: NOW });
    expect(result).toMatchObject({ weekly: null });
    const data = savedData();
    expect(data.attempts).toEqual({ [WEEK_ID]: 1 });
    expect(data.lastError).toBe("TypeError");
    expect(data).not.toHaveProperty("lastWeek");
    expect(JSON.stringify(data)).not.toContain("secret-page");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "secret-page",
    );
  });

  it("marks the week and counts it skipped on the fifth failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ attempts: { [WEEK_ID]: 4 } }),
    );
    deps.weeklyWrite.mockRejectedValue(new Error("boom"));
    await GaReports.runLink("link-1", { now: NOW });
    const data = savedData();
    expect(data.lastWeek).toBe("2026-10-05");
    expect(data.attempts).toEqual({});
    expect(data.stats).toMatchObject({ skipped: { weekly_failed: 1 } });
  });

  it("keeps running later stages after a stage failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    deps.refreshLink.mockRejectedValue(new Error("goals down"));
    const result = await GaReports.runLink("link-1", { now: NOW });
    expect(result).toMatchObject({ weekly: "posted" });
    expect(savedData()).toMatchObject({ lastError: "Error" });
    expect(savedData()).not.toHaveProperty("lastGoalsDay");
  });
});

describe("GaReports.runLink (alerts, pulse and plan)", () => {
  it("scans alerts from the last scan minus ten minutes", async () => {
    const lastScan = new Date("2026-10-12T05:00:00.000Z");
    deps.loadGaReportContext.mockResolvedValue(
      context({ settings: settings({ alertChat: true }) }),
    );
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ lastAlertScanAt: lastScan, lastWeek: "2026-10-05" }),
    );
    deps.postAlertCards.mockResolvedValue(1);
    const result = await GaReports.runLink("link-1", { now: NOW });
    expect(deps.postAlertCards).toHaveBeenCalledWith(
      expect.anything(),
      new Date("2026-10-12T04:50:00.000Z"),
    );
    expect(result).toMatchObject({ alerts: 1 });
    expect(savedData().lastAlertScanAt).toEqual(NOW);
  });

  it("does not scan alerts when the setting is off", async () => {
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.postAlertCards).not.toHaveBeenCalled();
  });

  it("evaluates the pulse once per new day and clears the wait", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({ settings: settings({ pulse: "notable" }) }),
    );
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ lastWeek: "2026-10-05", pulsePendingDay: "2026-10-11" }),
    );
    deps.pulseWrite.mockResolvedValue("quiet");
    const result = await GaReports.runLink("link-1", { now: NOW });
    expect(result).toMatchObject({ pulse: "quiet" });
    expect(deps.pulseWrite).toHaveBeenCalledWith(
      expect.anything(),
      "2026-10-11",
      new Date(NOW.getTime() - 48 * 3_600_000),
    );
    expect(savedData()).toMatchObject({
      lastPulseDay: "2026-10-11",
      lastPulseAt: NOW,
      pulsePendingDay: null,
      pulsePendingSince: null,
    });
  });

  it("waits for the daily analysis when insights are on", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({ settings: settings({ pulse: "notable" }), insights: "on" }),
    );
    db.gaReportRun.findUniqueOrThrow.mockResolvedValue(
      run({ lastWeek: "2026-10-05" }),
    );
    deps.insightsProgressOf.mockResolvedValue({
      lastWeek: "2026-10-05",
      lastDailyDay: "2026-10-10",
    });
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.pulseWrite).not.toHaveBeenCalled();
    expect(savedData()).toMatchObject({
      pulsePendingDay: "2026-10-11",
      pulsePendingSince: NOW,
    });
  });

  it("posts the monthly report and then the plan in one run", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({
        settings: settings({ monthlyEnabled: true, weeklyEnabled: false }),
        localNow: "2026-11-02T08:30",
        propertyToday: "2026-11-02",
        completeThrough: "2026-11-01",
      }),
    );
    deps.monthlyWrite.mockResolvedValue({ result: "posted", narrative: "ok" });
    const result = await GaReports.runLink("link-1", {
      now: NOW,
      llmBudget: 2,
    });
    expect(result).toMatchObject({
      monthly: "posted",
      plan: "posted",
      llmCalls: 1,
    });
    expect(deps.writePlan).toHaveBeenCalledWith(expect.anything(), "2026-11");
    expect(savedData()).toMatchObject({
      lastMonth: "2026-10",
      lastPlanMonth: "2026-11",
    });
  });

  it("holds the plan while the monthly report waits for data", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({
        settings: settings({ monthlyEnabled: true, weeklyEnabled: false }),
        localNow: "2026-11-02T08:30",
        propertyToday: "2026-11-02",
        completeThrough: "2026-10-29",
      }),
    );
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.monthlyWrite).not.toHaveBeenCalled();
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.historyDaysOf).not.toHaveBeenCalled();
  });

  it("does not mark the plan when the history is too short", async () => {
    deps.loadGaReportContext.mockResolvedValue(
      context({
        settings: settings({ monthlyEnabled: true, weeklyEnabled: false }),
        localNow: "2026-11-02T08:30",
        propertyToday: "2026-11-02",
        completeThrough: "2026-11-01",
      }),
    );
    deps.monthlyWrite.mockResolvedValue({ result: "posted", narrative: null });
    deps.historyDaysOf.mockResolvedValue(30);
    await GaReports.runLink("link-1", { now: NOW });
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(savedData()).not.toHaveProperty("lastPlanMonth");
  });
});

describe("GaReports (GA-F8 extra properties)", () => {
  const EXTRA = { ...LINK, id: "link-x", isPrimary: false, isSecondary: true };

  it("skips an extra property when GA_AGENCY is off", async () => {
    db.gaPropertyLink.findUnique.mockResolvedValue(EXTRA);
    expect(await GaReports.runLink("link-x", { now: NOW })).toBe("skipped");
    expect(db.gaReportRun.upsert).not.toHaveBeenCalled();
  });

  it("keeps the exact candidate where when GA_AGENCY is off", async () => {
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "a" }]);
    await GaReports.runDue(4, NOW);
    const fresh = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(fresh.where).toEqual({
      isPrimary: true,
      lastDailyDate: { not: null },
      reportRun: null,
    });
    const seen = db.gaReportRun.findMany.mock.calls[0]?.[0] as {
      where: { link: Record<string, unknown> };
    };
    expect(seen.where.link).toEqual({
      isPrimary: true,
      lastDailyDate: { not: null },
    });
  });

  it("widens both candidate queries to extras when GA_AGENCY is on", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    db.gaPropertyLink.findMany.mockResolvedValue([{ id: "a" }]);
    await GaReports.runDue(4, NOW);
    const widened = [{ isPrimary: true }, { isSecondary: true }];
    const fresh = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(fresh.where.OR).toEqual(widened);
    const seen = db.gaReportRun.findMany.mock.calls[0]?.[0] as {
      where: { link: Record<string, unknown> };
    };
    expect(seen.where.link.OR).toEqual(widened);
  });

  it("runs only weekly and monthly for an extra, with the template narrative", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    db.gaPropertyLink.findUnique.mockResolvedValue(EXTRA);
    deps.loadGaReportContext.mockResolvedValue(
      context({
        link: EXTRA,
        settings: settings({
          pulse: "notable",
          alertChat: true,
          monthlyEnabled: true,
        }),
      }),
    );
    const result = await GaReports.runLink("link-x", {
      now: NOW,
      llmBudget: 3,
    });
    expect(result).toMatchObject({ weekly: "posted", llmCalls: 0 });
    // Deterministik şablon: bütçe ne olursa olsun "skip".
    expect(deps.weeklyWrite).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "off",
      { narrative: "skip" },
    );
    expect(deps.refreshLink).not.toHaveBeenCalled();
    expect(deps.postAlertCards).not.toHaveBeenCalled();
    expect(deps.pulseWrite).not.toHaveBeenCalled();
    expect(deps.writePlan).not.toHaveBeenCalled();
    expect(deps.historyDaysOf).not.toHaveBeenCalled();
    const data = savedData();
    expect(data).toMatchObject({ lastWeek: "2026-10-05" });
    for (const key of [
      "lastGoalsDay",
      "lastPulseDay",
      "lastPulseAt",
      "pulsePendingDay",
      "lastAlertScanAt",
      "lastPlanMonth",
    ]) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it("does not count LLM budget even for a status that would", async () => {
    vi.stubEnv("GA_AGENCY", "true");
    db.gaPropertyLink.findUnique.mockResolvedValue(EXTRA);
    deps.loadGaReportContext.mockResolvedValue(context({ link: EXTRA }));
    deps.weeklyWrite.mockResolvedValue({ result: "posted", narrative: "none" });
    const result = await GaReports.runLink("link-x", { now: NOW, llmBudget: 0 });
    expect(result).toMatchObject({ weekly: "posted", llmCalls: 0 });
  });
});
