import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: bayrak kapalıyken veritabanına hiç gidilmez;
// geliştirme sürecinde (canlı DB paylaşılırken) claimPeriodic alınmaz ve
// yalnız GSC_SYNC_DEV_PROJECTS bağları sorgulanır; tur sınırı (limit) ve
// MAX_LINK_RUNS uygulanır; kayıtlı bekleme süren bağ hiç çalıştırılmaz; "wait"
// bekleme anını saklar; not_final durumu ilerletmez, bayat dönem rapor yazmadan
// ilerler; aynı dönemin raporu ve komutu varsa ne ekleme ne LLM olur; geliştirme
// sürecindeki sahte bağ raporu saklar ama sohbete kart yazmaz; nabız bump
// olmadan yazılır; hata geri çekilme ve Google metni içermeyen lastError yazar.

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  linkFindUnique: vi.fn(),
  stateFindMany: vi.fn(),
  claimPeriodic: vi.fn(),
  readEngineState: vi.fn(),
  postSeoReportCard: vi.fn(),
  commandExists: vi.fn(),
  refreshSeoGoals: vi.fn(),
  reportContextForLink: vi.fn(),
  buildWeeklyReport: vi.fn(),
  buildMonthlyReport: vi.fn(),
  buildPulseReport: vi.fn(),
  buildRoadmapReport: vi.fn(),
  writeSeoNarrative: vi.fn(),
  ensureReportState: vi.fn(),
  claimReportLease: vi.fn(),
  releaseReportState: vi.fn(),
  findSeoReport: vi.fn(),
  insertSeoReport: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findMany: mocks.linkFindMany,
      findUnique: mocks.linkFindUnique,
    },
    seoReportState: { findMany: mocks.stateFindMany },
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("@/server/seo/opportunities/state", () => ({
  readEngineState: mocks.readEngineState,
}));
vi.mock("./chat", () => ({
  postSeoReportCard: mocks.postSeoReportCard,
  commandExists: mocks.commandExists,
}));
vi.mock("./goals", () => ({ refreshSeoGoals: mocks.refreshSeoGoals }));
vi.mock("./inputs", () => ({ reportContextForLink: mocks.reportContextForLink }));
vi.mock("./weekly", () => ({ buildWeeklyReport: mocks.buildWeeklyReport }));
vi.mock("./monthly", () => ({ buildMonthlyReport: mocks.buildMonthlyReport }));
vi.mock("./pulse", () => ({ buildPulseReport: mocks.buildPulseReport }));
vi.mock("./roadmap", () => ({ buildRoadmapReport: mocks.buildRoadmapReport }));
vi.mock("./narrative", () => ({ writeSeoNarrative: mocks.writeSeoNarrative }));
vi.mock("./store", () => ({
  ensureReportState: mocks.ensureReportState,
  claimReportLease: mocks.claimReportLease,
  releaseReportState: mocks.releaseReportState,
  findSeoReport: mocks.findSeoReport,
  insertSeoReport: mocks.insertSeoReport,
}));

const { MAX_LINK_RUNS, SeoReports } = await import("./runner");

// Hafta W = 2026-09-28; son kesin gün Pazar 2026-10-04; ay M = 2026-09-01.
const W = "2026-09-28";
const FINAL = "2026-10-04";
// Çarşamba 12:00 UTC: UTC projesinde Çarşamba 09:00'dan sonra (vadesi gelmiş).
const WEDNESDAY = new Date("2026-10-07T12:00:00.000Z");
const TUESDAY = new Date("2026-10-06T12:00:00.000Z");

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    isMock: false,
    isPrimary: true,
    lastFinalDate: FINAL,
    lastWeeklyWeek: W,
    lastMonthlyMonth: null,
    ...overrides,
  };
}

// Bütün diğer işler "yapıldı" sayılır: yalnız haftalık bakılır.
function state(overrides: Record<string, unknown> = {}) {
  return {
    id: "state-1",
    linkId: "link-1",
    pulseDay: FINAL,
    pulseCheckedAt: null,
    weeklyWeek: null,
    monthlyMonth: null,
    roadmapMonth: null,
    goalsDay: FINAL,
    weeklyWaitWeek: null,
    weeklyWaitUntil: null,
    monthlyWaitMonth: null,
    monthlyWaitUntil: null,
    nextRunAt: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

function snapshot(kind: string, periodKey: string, from = W, to = "2026-10-04") {
  return { kind, periodKey, period: { from, to, label: "x" } };
}

function use(
  linkRow: Record<string, unknown>,
  stateRow: Record<string, unknown>,
): void {
  mocks.linkFindMany.mockResolvedValue([linkRow]);
  mocks.linkFindUnique.mockResolvedValue(linkRow);
  mocks.stateFindMany.mockResolvedValue([stateRow]);
  mocks.ensureReportState.mockResolvedValue(stateRow);
  mocks.reportContextForLink.mockResolvedValue({
    link: linkRow,
    projectId: linkRow.projectId,
    workspaceId: "ws-1",
    brandId: "brand-1",
    language: "en",
    timezone: "UTC",
    finalThrough: linkRow.lastFinalDate,
    brandSplitReady: true,
    siteLabel: "example.com",
  });
}

function released(): Record<string, unknown> {
  const call = mocks.releaseReportState.mock.calls.at(-1);
  if (!call) throw new Error("state not released");
  return call[2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("SEO_REPORTS", "true");
  vi.stubEnv("GSC_SYNC", "true");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
  vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
  vi.stubEnv("SEO_INSIGHTS", "off");
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  mocks.claimPeriodic.mockResolvedValue(true);
  mocks.claimReportLease.mockResolvedValue(true);
  mocks.releaseReportState.mockResolvedValue(undefined);
  mocks.findSeoReport.mockResolvedValue(null);
  mocks.commandExists.mockResolvedValue(false);
  mocks.insertSeoReport.mockResolvedValue({ id: "rep-1" });
  mocks.postSeoReportCard.mockResolvedValue(true);
  mocks.refreshSeoGoals.mockResolvedValue(0);
  mocks.writeSeoNarrative.mockResolvedValue({ narrative: null, note: null });
  mocks.readEngineState.mockResolvedValue(null);
  mocks.buildWeeklyReport.mockResolvedValue({
    snapshot: snapshot("WEEKLY", `W:${W}`),
  });
  mocks.buildMonthlyReport.mockResolvedValue({ skipped: "not_final" });
  mocks.buildPulseReport.mockResolvedValue({ skipped: "quiet" });
  mocks.buildRoadmapReport.mockResolvedValue({ skipped: "no_data" });
  use(link(), state());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SeoReports.runDue gates", () => {
  it("returns 0 with no database call when SEO_REPORTS is off", async () => {
    vi.stubEnv("SEO_REPORTS", "false");
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("returns 0 with no database call without GSC_SYNC", async () => {
    vi.stubEnv("GSC_SYNC", "false");
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(0);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("does nothing when another process holds the periodic claim", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(0);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "seo.reports",
      600_000,
      WEDNESDAY,
    );
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });

  it("never claims in a dev process on the shared DB and queries only dev projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "proj-1, proj-9");
    await SeoReports.runDue(5, WEDNESDAY);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    const where = mocks.linkFindMany.mock.calls[0]?.[0]?.where;
    expect(where.projectId).toEqual({ in: ["proj-1", "proj-9"] });
  });

  it("does nothing in a dev process without allow-listed projects", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(0);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
  });
});

describe("SeoReports.runDue selection", () => {
  it("stops after `limit` written reports", async () => {
    const links = Array.from({ length: 4 }, (_, index) =>
      link({ id: `link-${index}`, projectId: `proj-${index}` }),
    );
    mocks.linkFindMany.mockResolvedValue(links);
    mocks.stateFindMany.mockResolvedValue(
      links.map((row) => state({ id: `st-${row.id}`, linkId: row.id })),
    );
    mocks.linkFindUnique.mockImplementation(
      async ({ where }: { where: { id: string } }) =>
        links.find((row) => row.id === where.id) ?? null,
    );
    mocks.ensureReportState.mockImplementation(async (row: { id: string }) =>
      state({ id: `st-${row.id}`, linkId: row.id }),
    );
    mocks.reportContextForLink.mockImplementation(
      async (row: Record<string, unknown>) => ({
        link: row,
        projectId: row.projectId,
        workspaceId: "ws-1",
        brandId: "brand-1",
        language: "en",
        timezone: "UTC",
        finalThrough: FINAL,
        brandSplitReady: true,
        siteLabel: "example.com",
      }),
    );
    expect(await SeoReports.runDue(2, WEDNESDAY)).toBe(2);
    expect(mocks.linkFindUnique).toHaveBeenCalledTimes(2);
  });

  it("makes at most MAX_LINK_RUNS link runs even when nothing is posted", async () => {
    const links = Array.from({ length: MAX_LINK_RUNS + 5 }, (_, index) =>
      link({ id: `link-${index}`, projectId: `proj-${index}` }),
    );
    mocks.linkFindMany.mockResolvedValue(links);
    mocks.stateFindMany.mockResolvedValue([]);
    mocks.linkFindUnique.mockResolvedValue(null);
    await SeoReports.runDue(100, WEDNESDAY);
    expect(mocks.linkFindUnique).toHaveBeenCalledTimes(MAX_LINK_RUNS);
  });

  it("skips a link that waits for a later check and has nothing else due", async () => {
    use(
      link(),
      state({
        weeklyWaitWeek: W,
        weeklyWaitUntil: new Date("2026-10-07T13:00:00.000Z"),
      }),
    );
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(0);
    expect(mocks.linkFindUnique).not.toHaveBeenCalled();
  });

  it("runs the link once the wait is over", async () => {
    use(
      link(),
      state({
        weeklyWaitWeek: W,
        weeklyWaitUntil: new Date("2026-10-07T11:00:00.000Z"),
      }),
    );
    expect(await SeoReports.runDue(5, WEDNESDAY)).toBe(1);
  });

  it("skips a link in failure backoff", async () => {
    use(link(), state({ nextRunAt: new Date("2026-10-07T13:00:00.000Z") }));
    await SeoReports.runDue(5, WEDNESDAY);
    expect(mocks.linkFindUnique).not.toHaveBeenCalled();
  });

  it("skips a link with nothing to do", async () => {
    use(link(), state({ weeklyWeek: W }));
    await SeoReports.runDue(5, WEDNESDAY);
    expect(mocks.linkFindUnique).not.toHaveBeenCalled();
  });
});

describe("SeoReports.runLink weekly", () => {
  it("posts the weekly report under a link-keyed command with bump", async () => {
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual(["WEEKLY"]);
    expect(result.status).toBe("ran");
    const insert = mocks.insertSeoReport.mock.calls[0]?.[0];
    expect(insert.commandId).toBe(`seoweekly_link-1_${W}`);
    expect(insert.language).toBe("en");
    const post = mocks.postSeoReportCard.mock.calls[0]?.[0];
    expect(post.commandId).toBe(`seoweekly_link-1_${W}`);
    expect(post.bump).toBe(true);
    expect(post.card).toMatchObject({ kind: "seo-report", reportKind: "WEEKLY" });
    expect(released()).toMatchObject({
      weeklyWeek: W,
      consecutiveFailures: 0,
      nextRunAt: null,
      lastError: null,
    });
  });

  it("stores the wait instant before Wednesday 09:00 and builds nothing", async () => {
    const result = await SeoReports.runLink("link-1", { now: TUESDAY });
    expect(result.posted).toEqual([]);
    expect(mocks.buildWeeklyReport).not.toHaveBeenCalled();
    expect(released()).toMatchObject({
      weeklyWaitWeek: W,
      weeklyWaitUntil: new Date("2026-10-07T09:00:00.000Z"),
    });
    expect(released()).not.toHaveProperty("weeklyWeek");
  });

  it("builds regardless of the clock with ignoreTime", async () => {
    const result = await SeoReports.runLink("link-1", {
      now: TUESDAY,
      ignoreTime: true,
    });
    expect(result.posted).toEqual(["WEEKLY"]);
  });

  it("does not advance when the week is not final yet", async () => {
    mocks.buildWeeklyReport.mockResolvedValue({ skipped: "not_final" });
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.skipped).toContainEqual({
      kind: "WEEKLY",
      reason: "not_final",
    });
    expect(released()).not.toHaveProperty("weeklyWeek");
    expect(mocks.insertSeoReport).not.toHaveBeenCalled();
  });

  it("advances without posting when the week has no data", async () => {
    mocks.buildWeeklyReport.mockResolvedValue({ skipped: "no_data" });
    await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(released()).toMatchObject({ weeklyWeek: W });
    expect(mocks.postSeoReportCard).not.toHaveBeenCalled();
  });

  it("advances a stale week without building or posting", async () => {
    const result = await SeoReports.runLink("link-1", {
      now: new Date("2026-10-25T12:00:00.000Z"),
    });
    expect(result.posted).toEqual([]);
    expect(result.skipped).toContainEqual({ kind: "WEEKLY", reason: "stale" });
    expect(mocks.buildWeeklyReport).not.toHaveBeenCalled();
    expect(released()).toMatchObject({ weeklyWeek: W });
  });

  it("waits for the insight engine when it lags behind (SEO_INSIGHTS=on)", async () => {
    vi.stubEnv("SEO_INSIGHTS", "on");
    mocks.readEngineState.mockResolvedValue({ lastWeek: "2026-09-21" });
    // Çarşamba 12:00: rapor vakti geldi ama motor haftayı henüz işlemedi.
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual([]);
    expect(mocks.buildWeeklyReport).not.toHaveBeenCalled();
    const data = released();
    expect(data.weeklyWaitWeek).toBe(W);
    const until = data.weeklyWaitUntil as Date;
    expect(until.getTime()).toBe(WEDNESDAY.getTime() + 3_600_000);
  });
});

describe("SeoReports.runLink delivery", () => {
  it("does not insert, call the model or post when report and command exist", async () => {
    mocks.findSeoReport.mockResolvedValue({
      id: "rep-0",
      commandId: `seoweekly_link-1_${W}`,
      periodLabel: "Sep 28 – Oct 4",
    });
    mocks.commandExists.mockResolvedValue(true);
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual([]);
    expect(mocks.insertSeoReport).not.toHaveBeenCalled();
    expect(mocks.writeSeoNarrative).not.toHaveBeenCalled();
    expect(mocks.postSeoReportCard).not.toHaveBeenCalled();
    expect(released()).toMatchObject({ weeklyWeek: W });
  });

  it("re-posts the card of an existing report whose command is missing, reusing its command id", async () => {
    mocks.findSeoReport.mockResolvedValue({
      id: "rep-0",
      commandId: "seoweekly_old_id",
      periodLabel: "Sep 28 – Oct 4",
    });
    mocks.commandExists.mockResolvedValue(false);
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual(["WEEKLY"]);
    expect(mocks.insertSeoReport).not.toHaveBeenCalled();
    expect(mocks.writeSeoNarrative).not.toHaveBeenCalled();
    expect(mocks.postSeoReportCard.mock.calls[0]?.[0]).toMatchObject({
      commandId: "seoweekly_old_id",
    });
  });

  it("stores a mock link's report but writes no chat card in a dev process on the shared DB", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@db.example.com:5432/live");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "proj-1");
    vi.stubEnv("AGENTELSE_PROVIDER_MODE", "mock");
    use(link({ isMock: true }), state());
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(mocks.insertSeoReport).toHaveBeenCalledTimes(1);
    expect(mocks.writeSeoNarrative.mock.calls[0]?.[2]).toEqual({
      mockLink: true,
    });
    expect(mocks.postSeoReportCard).not.toHaveBeenCalled();
    expect(result.posted).toEqual([]);
    expect(result.skipped).toContainEqual({
      kind: "WEEKLY",
      reason: "mock_no_chat",
    });
    expect(released()).toMatchObject({ weeklyWeek: W });
  });

  it("skips with insert_failed when the insert loses and no row exists", async () => {
    mocks.insertSeoReport.mockResolvedValue(null);
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.skipped).toContainEqual({
      kind: "WEEKLY",
      reason: "insert_failed",
    });
    expect(mocks.postSeoReportCard).not.toHaveBeenCalled();
  });

  it("posts a pulse without bumping the chat", async () => {
    use(link(), state({ pulseDay: null, weeklyWeek: W }));
    mocks.buildPulseReport.mockResolvedValue({
      snapshot: snapshot("PULSE", `D:${FINAL}`, FINAL, FINAL),
    });
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual(["PULSE"]);
    expect(mocks.postSeoReportCard.mock.calls[0]?.[0]).toMatchObject({
      bump: false,
      commandId: `seopulse_link-1_${FINAL}`,
    });
    expect(released()).toMatchObject({ pulseDay: FINAL });
    expect(released().pulseCheckedAt).toEqual(WEDNESDAY);
  });

  it("advances over a quiet pulse day without posting", async () => {
    use(link(), state({ pulseDay: null, weeklyWeek: W }));
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.posted).toEqual([]);
    expect(released()).toMatchObject({ pulseDay: FINAL });
  });

  it("refreshes goals when the final day moved on", async () => {
    use(link(), state({ goalsDay: "2026-10-03", weeklyWeek: W }));
    mocks.refreshSeoGoals.mockResolvedValue(2);
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.goals).toBe(2);
    expect(released()).toMatchObject({ goalsDay: FINAL });
  });
});

describe("SeoReports.runLink monthly", () => {
  const MONTHLY_DAY = new Date("2026-10-07T12:00:00.000Z");

  it("posts the monthly report and the roadmap, then marks both months", async () => {
    use(link({ lastMonthlyMonth: "2026-09-01" }), state({ weeklyWeek: W }));
    mocks.buildMonthlyReport.mockResolvedValue({
      snapshot: snapshot("MONTHLY", "M:2026-09", "2026-09-01", "2026-09-30"),
    });
    mocks.buildRoadmapReport.mockResolvedValue({
      snapshot: snapshot("ROADMAP", "M:2026-10", "2026-10-01", "2026-10-31"),
    });
    const result = await SeoReports.runLink("link-1", { now: MONTHLY_DAY });
    expect(result.posted).toEqual(["MONTHLY", "ROADMAP"]);
    expect(mocks.buildRoadmapReport.mock.calls[0]?.[1]).toBe("2026-10-01");
    expect(released()).toMatchObject({
      monthlyMonth: "2026-09-01",
      roadmapMonth: "2026-10-01",
    });
    expect(mocks.postSeoReportCard.mock.calls.map((call) => call[0].commandId))
      .toEqual(["seomonthly_link-1_2026-09", "seoroadmap_link-1_2026-10"]);
  });

  it("refreshes goals before the monthly report when this run did not", async () => {
    use(
      link({ lastMonthlyMonth: "2026-09-01" }),
      state({ weeklyWeek: W, goalsDay: FINAL }),
    );
    await SeoReports.runLink("link-1", { now: MONTHLY_DAY });
    expect(mocks.refreshSeoGoals).toHaveBeenCalledTimes(1);
  });

  it("waits until the 4th 09:00 before the monthly report", async () => {
    use(link({ lastMonthlyMonth: "2026-09-01" }), state({ weeklyWeek: W }));
    const result = await SeoReports.runLink("link-1", {
      now: new Date("2026-10-03T12:00:00.000Z"),
    });
    expect(result.posted).toEqual([]);
    expect(mocks.buildMonthlyReport).not.toHaveBeenCalled();
    expect(released()).toMatchObject({
      monthlyWaitMonth: "2026-09-01",
      monthlyWaitUntil: new Date("2026-10-04T09:00:00.000Z"),
    });
  });

  it("does not advance the month when it is not final", async () => {
    use(link({ lastMonthlyMonth: "2026-09-01" }), state({ weeklyWeek: W }));
    await SeoReports.runLink("link-1", { now: MONTHLY_DAY });
    expect(mocks.buildRoadmapReport).not.toHaveBeenCalled();
    expect(released()).not.toHaveProperty("monthlyMonth");
  });
});

describe("SeoReports.runLink failures", () => {
  it("backs off with a lastError that carries no Google text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.buildWeeklyReport.mockRejectedValue(
      new Error("query: cheap flights to rome"),
    );
    use(link(), state({ consecutiveFailures: 1 }));
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.status).toBe("failed");
    const data = released();
    expect(data).toMatchObject({
      consecutiveFailures: 2,
      lastError: "Error: report run failed",
    });
    expect(data.nextRunAt).toEqual(new Date(WEDNESDAY.getTime() + 1_200_000));
    expect(data).not.toHaveProperty("weeklyWeek");
    expect(JSON.stringify([data, log.mock.calls])).not.toContain("rome");
  });

  it("returns busy when the lease is held", async () => {
    mocks.claimReportLease.mockResolvedValue(false);
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.status).toBe("busy");
    expect(mocks.releaseReportState).not.toHaveBeenCalled();
  });

  it("returns not_allowed for a project outside the allow-list", async () => {
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "other-project");
    const result = await SeoReports.runLink("link-1", { now: WEDNESDAY });
    expect(result.status).toBe("not_allowed");
    expect(mocks.ensureReportState).not.toHaveBeenCalled();
  });

  it("returns no_data for a missing link or a link without final days", async () => {
    mocks.linkFindUnique.mockResolvedValue(null);
    expect((await SeoReports.runLink("gone", { now: WEDNESDAY })).status).toBe(
      "no_data",
    );
    mocks.linkFindUnique.mockResolvedValue(link({ lastFinalDate: null }));
    expect((await SeoReports.runLink("link-1", { now: WEDNESDAY })).status).toBe(
      "no_data",
    );
  });
});
