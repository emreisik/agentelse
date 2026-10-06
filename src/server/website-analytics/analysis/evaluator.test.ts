import { beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: canlı veritabanını paylaşan geliştirme süreci
// paylaşılan kilidi (claimPeriodic) ve nabzı hiç kullanmaz, satırları
// GA_SYNC_DEV_PROJECTS ile süzer; canlıda 'ga.findings.evaluate' kilidi
// alınır, alınamazsa yalnız saklama denenir; kapalıyken değerlendirme
// sorgusu yok ama saklama (bayraktan bağımsız) denenir.

const db = vi.hoisted(() => ({
  gaFinding: { findMany: vi.fn(), updateMany: vi.fn() },
  gaPropertyLink: { findUnique: vi.fn() },
}));
const deps = vi.hoisted(() => ({
  claimPeriodic: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
  retention: vi.fn(),
  retentionWhileOff: vi.fn(),
  sweepIdleLinks: vi.fn(),
  writeFindingLearning: vi.fn(),
  loadExcludedDays: vi.fn(),
  loadGaWindowTables: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: deps.claimPeriodic,
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: deps.beat, ok: deps.ok },
}));
vi.mock("./retention", () => ({
  GaFindingRetention: {
    runDue: deps.retention,
    runWhileOff: deps.retentionWhileOff,
  },
}));
vi.mock("./sweep", () => ({ sweepIdleLinks: deps.sweepIdleLinks }));
vi.mock("./learnings", () => ({
  writeFindingLearning: deps.writeFindingLearning,
}));
vi.mock("./inputs", () => ({ loadExcludedDays: deps.loadExcludedDays }));
vi.mock("./windows", () => ({ loadGaWindowTables: deps.loadGaWindowTables }));

const { GaFindingEvaluator, resetGaFindingEvaluatorThrottle } =
  await import("./evaluator");

const REMOTE_DB =
  "postgresql://user:secret@ep-example.eu-central-1.aws.neon.tech/app";
const NOW = new Date("2026-10-07T10:00:00.000Z");

beforeEach(() => {
  vi.unstubAllEnvs();
  resetGaFindingEvaluatorThrottle();
  for (const mock of [
    ...Object.values(db).flatMap((model) => Object.values(model)),
    ...Object.values(deps),
  ]) {
    mock.mockReset();
  }
  db.gaFinding.findMany.mockResolvedValue([]);
  deps.claimPeriodic.mockResolvedValue(true);
  deps.retention.mockResolvedValue(0);
  deps.retentionWhileOff.mockResolvedValue(0);
  deps.sweepIdleLinks.mockResolvedValue({ expired: 0, resolved: 0 });
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_INSIGHTS", "shadow");
});

describe("GaFindingEvaluator.runDue", () => {
  it("never claims the shared lease or writes a heartbeat in a dev process and scopes rows", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "proj-1, proj-2");
    expect(await GaFindingEvaluator.runDue(20, NOW)).toBe(0);
    expect(deps.claimPeriodic).not.toHaveBeenCalled();
    expect(deps.beat).not.toHaveBeenCalled();
    expect(deps.ok).not.toHaveBeenCalled();
    const query = db.gaFinding.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where).toMatchObject({
      status: "DONE",
      evaluateAfter: { lte: NOW },
      projectId: { in: ["proj-1", "proj-2"] },
    });
    // Süreç içi kısma: 30 dakika içinde ikinci tur sorgu yapmaz.
    await GaFindingEvaluator.runDue(20, new Date(NOW.getTime() + 60_000));
    expect(db.gaFinding.findMany).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without any query in a dev process with an empty project list", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", REMOTE_DB);
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(await GaFindingEvaluator.runDue(20, NOW)).toBe(0);
    expect(db.gaFinding.findMany).not.toHaveBeenCalled();
    expect(deps.retention).not.toHaveBeenCalled();
  });

  it("claims ga.findings.evaluate in production and runs retention", async () => {
    await GaFindingEvaluator.runDue(20, NOW);
    expect(deps.claimPeriodic).toHaveBeenCalledWith(
      "ga.findings.evaluate",
      30 * 60_000,
      NOW,
    );
    const query = db.gaFinding.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(query.where.projectId).toBeUndefined();
    expect(deps.retention).toHaveBeenCalledWith(NOW);
    // Analizi duran bağların TTL süpürmesi de bu turda (kapsam yok).
    expect(deps.sweepIdleLinks).toHaveBeenCalledWith({
      now: NOW,
      projectIds: null,
    });
  });

  it("only runs retention when the lease is taken", async () => {
    deps.claimPeriodic.mockResolvedValue(false);
    expect(await GaFindingEvaluator.runDue(20, NOW)).toBe(0);
    expect(db.gaFinding.findMany).not.toHaveBeenCalled();
    expect(deps.retention).toHaveBeenCalledWith(NOW);
  });

  it("does nothing when GA_INSIGHTS is off", async () => {
    vi.stubEnv("GA_INSIGHTS", "off");
    expect(await GaFindingEvaluator.runDue(20, NOW)).toBe(0);
    expect(deps.claimPeriodic).not.toHaveBeenCalled();
    expect(db.gaFinding.findMany).not.toHaveBeenCalled();
    // Saklama bayraktan bağımsızdır (24 ay sözü).
    expect(deps.retentionWhileOff).toHaveBeenCalledWith(NOW);
    expect(deps.retention).not.toHaveBeenCalled();
  });

  it("closes a row with unreadable evidence as INCONCLUSIVE", async () => {
    const doneAt = new Date("2026-08-31T10:00:00.000Z");
    const row = {
      id: "f-1",
      linkId: "link-1",
      ruleKey: "AN3",
      status: "DONE",
      mode: "live",
      isMock: false,
      evidence: {},
      doneAt,
      evaluateAfter: new Date("2026-10-06T10:00:00.000Z"),
    };
    db.gaFinding.findMany.mockResolvedValue([row]);
    db.gaFinding.updateMany.mockResolvedValue({ count: 1 });
    db.gaPropertyLink.findUnique.mockResolvedValue({
      id: "link-1",
      timeZone: "Europe/Istanbul",
      lastDailyDate: "2026-10-05",
    });
    // Kanıt okunamıyor: INCONCLUSIVE (tracking_issue) ile kapanır.
    expect(await GaFindingEvaluator.runDue(20, NOW)).toBe(1);
    const close = db.gaFinding.updateMany.mock.calls[1]?.[0] as {
      data: { status: string; outcome: string; closedReason: string };
    };
    expect(close.data).toMatchObject({
      status: "EVALUATED",
      outcome: "INCONCLUSIVE",
      closedReason: "evaluated",
    });
    expect(deps.writeFindingLearning).not.toHaveBeenCalled();
  });
});
