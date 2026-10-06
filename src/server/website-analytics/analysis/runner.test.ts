import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: GA_INSIGHTS yokken ya da GA_SYNC kapalıyken
// runDue hiçbir sorgu yapmadan 0 döner; canlı veritabanını paylaşan
// geliştirme sürecinde aday sorgusu GA_SYNC_DEV_PROJECTS ile süzülür ve nabız
// yazılmaz; liste boşsa sorgu yok; yalnız haftalık tur süpürmeye daily=null
// verir (revised/recovered dokunulmaz); açıklama bütçe ya da hata yüzünden
// atlanırsa hafta ilerlemez ve haftalık olmayan turda yeniden denenir.

const db = vi.hoisted(() => ({
  project: { findMany: vi.fn() },
  gaPropertyLink: { findMany: vi.fn(), findUnique: vi.fn() },
  gaAnalysisRun: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
  brand: { findFirst: vi.fn() },
}));
const deps = vi.hoisted(() => ({
  beat: vi.fn(),
  ok: vi.fn(),
  loadDailyAnalysisInput: vi.fn(),
  loadWeeklyAnalysisInput: vi.fn(),
  loadExcludedDays: vi.fn(),
  runDailyRules: vi.fn(),
  runWeeklyRules: vi.fn(),
  persistCandidates: vi.fn(),
  sweepFindings: vi.fn(),
  ingestFindingSignals: vi.fn(),
  explainTopFindings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: deps.beat, ok: deps.ok },
}));
vi.mock("./inputs", () => ({
  loadDailyAnalysisInput: deps.loadDailyAnalysisInput,
  loadWeeklyAnalysisInput: deps.loadWeeklyAnalysisInput,
  loadExcludedDays: deps.loadExcludedDays,
}));
vi.mock("@/lib/website-analytics/analysis/run-rules", () => ({
  runDailyRules: deps.runDailyRules,
  runWeeklyRules: deps.runWeeklyRules,
}));
vi.mock("./persist", () => ({ persistCandidates: deps.persistCandidates }));
vi.mock("./sweep", () => ({ sweepFindings: deps.sweepFindings }));
vi.mock("./signals", () => ({
  ingestFindingSignals: deps.ingestFindingSignals,
}));
vi.mock("./explain", () => ({ explainTopFindings: deps.explainTopFindings }));

const { GaInsights } = await import("./runner");

const REMOTE_DB =
  "postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/app";
// Pazartesi 2026-10-05 12:00 İstanbul: önceki hafta (28 Eylül) vadesi geldi.
const NOW = new Date("2026-10-05T09:00:00.000Z");

const LINK = {
  id: "link-1",
  workspaceId: "ws-1",
  projectId: "proj-1",
  isPrimary: true,
  isMock: false,
  timeZone: "Europe/Istanbul",
  currencyCode: "EUR",
  // completeThrough = 2026-10-04 (Pazar)
  lastDailyDate: "2026-10-05",
  health: "OK",
};

function run(partial: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    linkId: "link-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    leaseUntil: null,
    leaseOwner: null,
    lastCheckedAt: null,
    lastDailyDay: null,
    lastDailyAt: null,
    lastWeek: null,
    lastWeeklyAt: null,
    lastMonth: null,
    lastExplainedWeek: null,
    lastError: null,
    stats: null,
    ...partial,
  };
}

function allDbMocks() {
  return Object.values(db).flatMap((model) => Object.values(model));
}

const PERSISTED = {
  created: [],
  refreshed: 0,
  superseded: 0,
  suppressed: 0,
  stale: 0,
  byRule: {},
};

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const mock of [...allDbMocks(), ...Object.values(deps)])
    mock.mockReset();
  db.project.findMany.mockResolvedValue([]);
  db.gaPropertyLink.findMany.mockResolvedValue([]);
  db.gaPropertyLink.findUnique.mockResolvedValue(LINK);
  db.gaAnalysisRun.upsert.mockResolvedValue(run());
  db.gaAnalysisRun.updateMany.mockResolvedValue({ count: 1 });
  db.gaAnalysisRun.update.mockResolvedValue(run());
  deps.loadExcludedDays.mockResolvedValue({
    suspect: new Set(),
    holidays: new Set(),
  });
  deps.loadWeeklyAnalysisInput.mockResolvedValue({});
  deps.runWeeklyRules.mockReturnValue([]);
  deps.persistCandidates.mockResolvedValue(PERSISTED);
  deps.sweepFindings.mockResolvedValue({ expired: 0, resolved: 0 });
});

describe("GaInsights.runDue", () => {
  it("returns 0 without any query when GA_INSIGHTS is unset", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "");
    expect(await GaInsights.runDue(5, NOW)).toBe(0);
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
    expect(deps.beat).not.toHaveBeenCalled();
  });

  it("returns 0 without any query when GA_SYNC is off", async () => {
    vi.stubEnv("GA_SYNC", "false");
    vi.stubEnv("GA_INSIGHTS", "on");
    expect(await GaInsights.runDue(5, NOW)).toBe(0);
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("scopes a dev process to GA_SYNC_DEV_PROJECTS and never writes the heartbeat", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "shadow");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "proj-1");
    db.gaPropertyLink.findMany.mockResolvedValue([
      {
        ...LINK,
        analysisRun: run({
          lastDailyDay: "2026-10-04",
          lastWeek: "2026-09-28",
        }),
      },
    ]);
    expect(await GaInsights.runDue(5, NOW)).toBe(0);
    const query = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: { projectId: { in: string[] } };
    };
    expect(query.where.projectId.in).toEqual(["proj-1"]);
    const projects = db.project.findMany.mock.calls[0]?.[0] as {
      where: { id: { in: string[] } };
    };
    expect(projects.where.id.in).toEqual(["proj-1"]);
    expect(deps.beat).not.toHaveBeenCalled();
    expect(deps.ok).not.toHaveBeenCalled();
    // Zamanı gelmeyen bağ da lastCheckedAt alır.
    expect(db.gaAnalysisRun.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { lastCheckedAt: NOW } }),
    );
  });

  it("returns 0 without any query in a dev process with an empty project list", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "on");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await GaInsights.runDue(5, NOW)).toBe(0);
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("writes the heartbeat and filters stopped projects in production", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "shadow");
    db.project.findMany.mockResolvedValue([{ id: "paused-1" }]);
    await GaInsights.runDue(5, NOW);
    const query = db.gaPropertyLink.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).toMatchObject({
      isPrimary: true,
      lastDailyDate: { not: null },
      projectId: { notIn: ["paused-1"] },
    });
    expect(deps.beat).toHaveBeenCalledWith("ga.analyze", NOW);
    expect(deps.ok).toHaveBeenCalledWith("ga.analyze", NOW);
  });
});

describe("GaInsights.analyzeLink", () => {
  it("passes daily=null to the sweep on a weekly-only run", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "shadow");
    db.gaAnalysisRun.findUniqueOrThrow.mockResolvedValue(
      run({
        lastDailyDay: "2026-10-04",
        lastWeek: "2026-09-21",
        lastMonth: "2026-09",
      }),
    );
    const result = await GaInsights.analyzeLink("link-1", { now: NOW });
    expect(result).toMatchObject({
      daily: [],
      week: "2026-09-28",
      month: null,
    });
    expect(deps.loadDailyAnalysisInput).not.toHaveBeenCalled();
    expect(deps.sweepFindings).toHaveBeenCalledWith(
      expect.objectContaining({ linkId: "link-1", daily: null }),
    );
    expect(deps.persistCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shadow" }),
    );
    // Gölge modda sinyal ve açıklama yok.
    expect(deps.ingestFindingSignals).not.toHaveBeenCalled();
    expect(deps.explainTopFindings).not.toHaveBeenCalled();
    // Kilit bırakılır.
    expect(db.gaAnalysisRun.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { leaseUntil: null, leaseOwner: null } }),
    );
  });

  it("keeps the week unexplained after a budget hit and retries on a later run", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "on");
    db.brand.findFirst.mockResolvedValue({ id: "brand-1" });
    deps.ingestFindingSignals.mockResolvedValue(0);
    deps.explainTopFindings.mockResolvedValueOnce({
      explained: 0,
      skipped: "budget",
    });
    db.gaAnalysisRun.findUniqueOrThrow.mockResolvedValueOnce(
      run({
        lastDailyDay: "2026-10-04",
        lastWeek: "2026-09-21",
        lastMonth: "2026-09",
      }),
    );
    await GaInsights.analyzeLink("link-1", { now: NOW });
    expect(deps.explainTopFindings).toHaveBeenCalledTimes(1);
    expect(db.gaAnalysisRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastWeek: "2026-09-28",
          lastExplainedWeek: null,
        }),
      }),
    );

    // Sonraki (haftalık olmayan) tur aynı haftayı yeniden açıklar.
    deps.explainTopFindings.mockResolvedValueOnce({
      explained: 2,
      skipped: null,
    });
    db.gaAnalysisRun.findUniqueOrThrow.mockResolvedValueOnce(
      run({
        lastDailyDay: "2026-10-04",
        lastWeek: "2026-09-28",
        lastMonth: "2026-09",
      }),
    );
    const result = await GaInsights.analyzeLink("link-1", { now: NOW });
    expect(result).toMatchObject({ week: null, explained: 2 });
    expect(deps.explainTopFindings).toHaveBeenCalledTimes(2);
    expect(db.gaAnalysisRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastExplainedWeek: "2026-09-28" }),
      }),
    );
  });

  it("returns busy when the lease is held", async () => {
    vi.stubEnv("GA_SYNC", "true");
    vi.stubEnv("GA_INSIGHTS", "on");
    db.gaAnalysisRun.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await GaInsights.analyzeLink("link-1", { now: NOW })).toBe("busy");
    expect(deps.persistCandidates).not.toHaveBeenCalled();
  });
});
