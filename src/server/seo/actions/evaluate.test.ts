import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageSeries } from "@/lib/seo/actions/did";

// Bu dosyanın kanıtladığı: bayrak kapalıyken veritabanına gidilmez; pencereler
// measureFrom'dan kurulur (appliedAt'ten değil); pencere hazır değilse +24 saat
// beklenir ve evaluateAfter + 21 günde INCONCLUSIVE NO_DATA olur; eksik kapsama
// NO_DATA, bağsız eylem NO_SEARCH_DATA verir; ALERT, CRUX, SITEMAP ve LAUNCH
// kararları; PT günüyle karşılaştırılan güncelleme çakışması; yıllık düzeltme
// yalnız tam geçen yıl kapsamasıyla; bulgu yalnız DONE'dan EVALUATED olur ve
// öğrenme yazımı sonuç yazıldıktan sonra çağrılır.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  link: vi.fn(),
  alert: vi.fn(),
  finding: vi.fn(),
  updates: vi.fn(),
  site: vi.fn(),
  cwv: vi.fn(),
  series: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  writeFor: vi.fn(),
  curves: vi.fn(),
  gscSitemaps: vi.fn(),
  inspections: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    seoAction: { findUnique: mocks.findUnique, findMany: mocks.findMany },
    gscSiteLink: { findUnique: mocks.link },
    adsAlert: { findUnique: mocks.alert },
    seoFinding: { updateMany: mocks.finding },
    searchUpdate: { findMany: mocks.updates },
    seoSite: { findUnique: mocks.site },
    seoCwv: { findMany: mocks.cwv },
  },
}));
vi.mock("./series", () => ({ loadActionSeries: mocks.series }));
vi.mock("./store", () => ({
  actionViewOf: (row: unknown) => row,
  claimAction: mocks.claim,
  releaseAction: mocks.release,
}));
vi.mock("./learnings", () => ({ SeoLearnings: { writeFor: mocks.writeFor } }));
vi.mock("@/server/seo/opportunities/state", () => ({
  readSeoCurves: mocks.curves,
}));
vi.mock("@/server/seo/health/google-reads", () => ({
  readGscSitemaps: mocks.gscSitemaps,
  readInspectionsFor: mocks.inspections,
}));
vi.mock("@/server/seo/crawl/sitemaps", () => ({
  sitemapSummaryOk: (summary: { status: number | null }) =>
    summary.status === 200,
}));
vi.mock("@/server/seo/site/sites", () => ({
  parseSitemapSummaries: (value: unknown) =>
    Array.isArray(value) ? value : [],
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

const { SeoActionEvaluator } = await import("./evaluate");
const { evaluationWindows, yearAgoWeeks } =
  await import("@/lib/seo/actions/windows");
const { actionViewFixture, proposalFixture } =
  await import("@/lib/seo/actions/test-support");

const MEASURE_FROM = new Date("2026-08-05T12:00:00.000Z");
const EVALUATE_AFTER = new Date("2026-09-02T12:00:00.000Z");
const NOW = new Date("2026-09-10T12:00:00.000Z");
const WINDOWS = evaluationWindows({
  measureFrom: MEASURE_FROM,
  windowDays: 28,
});
const PRE = WINDOWS.preWeeks;
const POST = WINDOWS.postWeeks;
const ALL_WEEKS = [...PRE, ...POST];
const ENV_KEYS = [
  "SEO_ACTIONS",
  "SEO_HEALTH",
  "SEO_CRAWL",
  "GOOGLE_API_KEY",
  "AGENTELSE_PROVIDER_MODE",
  "SEO_DEV_PROJECTS",
  "SEO_ROLLOUT_PROJECTS",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type Overrides = Parameters<typeof actionViewFixture>[0];

function view(overrides: Overrides = {}) {
  return actionViewFixture({
    id: "action-1",
    kind: "TITLE_META",
    status: "EVALUATING",
    linkId: "link-1",
    appliedAt: new Date("2026-05-01T12:00:00.000Z"),
    measureFrom: MEASURE_FROM,
    evaluateAfter: EVALUATE_AFTER,
    windowDays: 28,
    findingId: "finding-1",
    ...overrides,
  });
}

type Metric = { clicks: number; impressions: number };

function build(
  pageId: string,
  weeks: readonly string[],
  metric: (week: string) => Metric,
): PageSeries {
  return {
    pageId,
    weeks: weeks.map((weekStart) => {
      const { clicks, impressions } = metric(weekStart);
      return { weekStart, clicks, impressions, positionWeighted: impressions * 5 };
    }),
  };
}

function constant(
  pageId: string,
  clicks: number,
  impressions: number,
  weeks: readonly string[] = ALL_WEEKS,
): PageSeries {
  return build(pageId, weeks, () => ({ clicks, impressions }));
}

// Gösterim sabit (200), tıklama önce 20, sonra `after`: CTR yükselir.
function treatedSeries(after: number): PageSeries {
  return build("treated", ALL_WEEKS, (week) => ({
    clicks: PRE.includes(week) ? 20 : after,
    impressions: 200,
  }));
}

function controlSeries(count: number): PageSeries[] {
  return Array.from({ length: count }, (_, index) =>
    constant(`control-${index}`, 20, 200),
  );
}

type SeriesOverrides = Partial<{
  treated: PageSeries[];
  candidates: PageSeries[];
  treatedYearAgo: PageSeries[];
  yearAgoCovered: boolean;
  coveredWeeks: Set<string>;
  truncated: boolean;
  overlappingChange: boolean;
}>;

function loaded(overrides: SeriesOverrides = {}) {
  return {
    linkId: "link-1",
    lastWeeklyWeek: "2026-09-07",
    treated: [treatedSeries(28)],
    treatedYearAgo: [],
    candidates: controlSeries(5),
    excluded: new Set<string>(),
    coveredWeeks: new Set(ALL_WEEKS),
    yearAgoCovered: false,
    truncated: false,
    pageGroup: "services",
    overlappingChange: false,
    ...overrides,
  };
}

function releasedData(): Record<string, unknown> {
  const call = mocks.release.mock.calls.at(-1);
  if (!call) throw new Error("release çağrılmadı");
  return call[2] as Record<string, unknown>;
}

function evaluation(): Record<string, unknown> {
  return releasedData().evaluation as Record<string, unknown>;
}

async function run(
  overrides: Overrides = {},
  now: Date = NOW,
): Promise<Awaited<ReturnType<typeof SeoActionEvaluator.evaluateAction>>> {
  const action = view(overrides);
  mocks.findUnique.mockResolvedValue(action);
  return SeoActionEvaluator.evaluateAction(action.id, { now });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  process.env.SEO_ACTIONS = "true";
  process.env.SEO_HEALTH = "true";
  process.env.SEO_CRAWL = "true";
  process.env.GOOGLE_API_KEY = "test-key";
  delete process.env.AGENTELSE_PROVIDER_MODE;
  delete process.env.SEO_DEV_PROJECTS;
  delete process.env.SEO_ROLLOUT_PROJECTS;
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(true);
  mocks.writeFor.mockResolvedValue(false);
  mocks.link.mockResolvedValue({ lastWeeklyWeek: "2026-09-07" });
  mocks.series.mockResolvedValue(loaded());
  mocks.updates.mockResolvedValue([]);
  mocks.curves.mockResolvedValue(null);
  mocks.finding.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue(undefined);
  mocks.alert.mockResolvedValue({ status: "RESOLVED" });
  mocks.site.mockResolvedValue({ id: "site-1", sitemaps: [] });
  mocks.cwv.mockResolvedValue([]);
  mocks.gscSitemaps.mockResolvedValue([]);
  mocks.inspections.mockResolvedValue(new Map());
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("flags and skipping", () => {
  it("returns 0 without touching the database when the loop is off", async () => {
    process.env.SEO_ACTIONS = "false";
    expect(await SeoActionEvaluator.runDue(10, NOW)).toBe(0);
    expect(
      (await SeoActionEvaluator.evaluateAction("a", { now: NOW })).status,
    ).toBe("skipped");
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("skips a row that is not EVALUATING or of another mode", async () => {
    expect((await run({ status: "APPLIED" })).status).toBe("skipped");
    expect((await run({ isMock: true })).status).toBe("skipped");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("is busy when the lease is taken", async () => {
    mocks.claim.mockResolvedValue(false);
    expect((await run()).status).toBe("busy");
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("waits without writing before evaluateAfter", async () => {
    const result = await run({}, new Date("2026-09-01T12:00:00.000Z"));
    expect(result.status).toBe("waiting");
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("selects due EVALUATING rows of the current mode and counts evaluated ones", async () => {
    mocks.findMany.mockResolvedValue([{ id: "action-1" }]);
    mocks.findUnique.mockResolvedValue(view());
    expect(await SeoActionEvaluator.runDue(10, NOW)).toBe(1);
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where.status).toBe("EVALUATING");
    expect(where.isMock).toBe(false);
    expect(where.evaluateAfter).toEqual({ lte: NOW });
  });

  it("never throws from the series loader", async () => {
    mocks.series.mockRejectedValue(new Error("db"));
    const result = await run();
    expect(result.status).toBe("waiting");
    expect(releasedData().nextCheckAt).toEqual(
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(releasedData().status).toBeUndefined();
  });
});

describe("windows and waiting", () => {
  it("builds the windows from measureFrom, not appliedAt", async () => {
    await run({ appliedAt: new Date("2026-03-01T12:00:00.000Z") });
    const input = mocks.series.mock.calls[0]![0];
    expect(input.windows.anchorDay).toBe("2026-08-05");
    expect(input.windows.preWeeks).toEqual(PRE);
    expect(evaluation().anchorDay).toBe("2026-08-05");
  });

  it("falls back to appliedAt with a warning when measureFrom is missing", async () => {
    await run({
      measureFrom: null,
      appliedAt: MEASURE_FROM,
    });
    expect(mocks.series.mock.calls[0]![0].windows.anchorDay).toBe("2026-08-05");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("action-1"),
    );
  });

  it("waits 24 hours when the warehouse has not reached the last week", async () => {
    mocks.link.mockResolvedValue({ lastWeeklyWeek: PRE[PRE.length - 1] });
    const result = await run();
    expect(result.status).toBe("waiting");
    expect(releasedData()).toEqual({
      nextCheckAt: new Date(NOW.getTime() + 86_400_000),
    });
    expect(mocks.series).not.toHaveBeenCalled();
  });

  it("gives up with INCONCLUSIVE NO_DATA 21 days after evaluateAfter", async () => {
    mocks.link.mockResolvedValue({ lastWeeklyWeek: PRE[PRE.length - 1] });
    const late = new Date(EVALUATE_AFTER.getTime() + 21 * 86_400_000);
    const result = await run({}, late);
    expect(result).toEqual({ status: "evaluated", outcome: "INCONCLUSIVE" });
    expect(evaluation().reason).toBe("NO_DATA");
    expect(releasedData().status).toBe("INCONCLUSIVE");
    expect(releasedData().openKey).toBeNull();
    expect(releasedData().nextCheckAt).toBeNull();
  });

  it("is NO_DATA when too few pre weeks are covered", async () => {
    mocks.series.mockResolvedValue(
      loaded({ coveredWeeks: new Set([...PRE.slice(0, 3), ...POST]) }),
    );
    await run();
    expect(evaluation().reason).toBe("NO_DATA");
    expect(evaluation().outcome).toBe("INCONCLUSIVE");
  });

  it("is NO_DATA when too few post weeks are covered", async () => {
    mocks.series.mockResolvedValue(
      loaded({ coveredWeeks: new Set([...PRE, POST[0]!]) }),
    );
    await run();
    expect(evaluation().reason).toBe("NO_DATA");
  });

  it("is NO_SEARCH_DATA without a link and does not load a series", async () => {
    await run({ linkId: null });
    expect(evaluation().reason).toBe("NO_SEARCH_DATA");
    expect(mocks.series).not.toHaveBeenCalled();
  });

  it("is NO_SEARCH_DATA when the link row is gone", async () => {
    mocks.link.mockResolvedValue(null);
    await run();
    expect(evaluation().reason).toBe("NO_SEARCH_DATA");
  });

  it("is NO_PAGE when the target page is not in the warehouse", async () => {
    mocks.series.mockResolvedValue({ missing: "NO_PAGE" });
    await run();
    expect(evaluation().reason).toBe("NO_PAGE");
  });
});

describe("difference-in-differences", () => {
  it("marks a clear lift as WORKED with SIGNIFICANT confidence and controls", async () => {
    const result = await run();
    expect(result).toEqual({ status: "evaluated", outcome: "WORKED" });
    const evalJson = evaluation();
    expect(evalJson.method).toBe("DID");
    expect(evalJson.metric).toBe("ctr_adj");
    expect(evalJson.controls).toBe(5);
    expect(evalJson.confidence).toBe("SIGNIFICANT");
    expect(evalJson.effect as number).toBeCloseTo(0.4, 1);
    expect(releasedData().confidence).toBe("SIGNIFICANT");
    expect(releasedData().status).toBe("WORKED");
    expect(evalJson.preWeeks).toEqual(PRE);
    expect(evalJson.postWeeks).toEqual(POST);
  });

  it("marks a flat page as DIDNT", async () => {
    mocks.series.mockResolvedValue(loaded({ treated: [treatedSeries(20)] }));
    const result = await run();
    expect(result.outcome).toBe("DIDNT");
    expect(releasedData().status).toBe("DIDNT");
  });

  it("caps a decisive outcome at INCONCLUSIVE GOOGLE_UPDATE when an update overlaps", async () => {
    mocks.updates.mockResolvedValue([
      {
        name: "Core update",
        kind: "CORE",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        endedAt: new Date("2026-08-10T00:00:00.000Z"),
      },
    ]);
    await run();
    const evalJson = evaluation();
    expect(evalJson.outcome).toBe("INCONCLUSIVE");
    expect(evalJson.reason).toBe("GOOGLE_UPDATE");
    expect(evalJson.confidence).toBe("DIRECTIONAL");
    expect(evalJson.updates).toEqual([
      {
        name: "Core update",
        kind: "CORE",
        startedAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-10T00:00:00.000Z",
      },
    ]);
  });

  it("compares update boundaries as PT days", async () => {
    // overlapFrom = 2026-07-08. 7 Tem 23:00 PT = 8 Tem 06:00 UTC: önceki gün.
    mocks.updates.mockResolvedValue([
      {
        name: "Earlier",
        kind: "CORE",
        startedAt: new Date("2026-06-20T00:00:00.000Z"),
        endedAt: new Date("2026-07-08T06:00:00.000Z"),
      },
    ]);
    await run();
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().updates).toEqual([]);

    // 8 Tem 12:00 PT: pencerenin ilk günü, örtüşür.
    mocks.updates.mockResolvedValue([
      {
        name: "Overlapping",
        kind: "CORE",
        startedAt: new Date("2026-06-20T00:00:00.000Z"),
        endedAt: new Date("2026-07-08T19:00:00.000Z"),
      },
    ]);
    await run();
    expect(evaluation().reason).toBe("GOOGLE_UPDATE");
  });

  it("ignores non-ranking updates", async () => {
    mocks.updates.mockResolvedValue([
      {
        name: "Outage",
        kind: "SERVING",
        startedAt: new Date("2026-08-01T00:00:00.000Z"),
        endedAt: null,
      },
    ]);
    await run();
    expect(evaluation().outcome).toBe("WORKED");
  });

  it("caps at OVERLAPPING_CHANGE when another action hit the treated page", async () => {
    mocks.series.mockResolvedValue(loaded({ overlappingChange: true }));
    await run();
    expect(evaluation().reason).toBe("OVERLAPPING_CHANGE");
  });

  it("is LOW_DATA with a tiny treated page", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        treated: [
          build("treated", ALL_WEEKS, (week) => ({ clicks: PRE.includes(week) ? 1 : 2, impressions: 10 })),
        ],
        candidates: [],
      }),
    );
    await run();
    expect(evaluation().reason).toBe("LOW_DATA");
  });

  it("is DIRECTIONAL with the site aggregate when fewer than 3 controls are in band", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        candidates: [
          constant("far-1", 2, 20),
          constant("far-2", 3, 30),
        ],
      }),
    );
    await run();
    expect(evaluation().method).toBe("DID_SITE");
    expect(evaluation().confidence).toBe("DIRECTIONAL");
  });

  it("uses plain pre/post when year-ago weeks are not fully covered", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        candidates: [],
        treatedYearAgo: [
          constant("treated", 20, 200, yearAgoWeeks(ALL_WEEKS)),
        ],
        yearAgoCovered: false,
      }),
    );
    await run();
    expect(evaluation().method).toBe("PRE_POST");
    expect(evaluation().yoyAdjusted).toBe(false);
    expect(evaluation().confidence).toBe("DIRECTIONAL");
    expect(evaluation().yoy).toBeNull();
  });

  it("adjusts pre/post for last year only with full year-ago coverage", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        candidates: [],
        treatedYearAgo: [
          constant("treated", 20, 200, yearAgoWeeks(ALL_WEEKS)),
        ],
        yearAgoCovered: true,
      }),
    );
    await run();
    expect(evaluation().method).toBe("PRE_POST");
    expect(evaluation().yoyAdjusted).toBe(true);
    expect(evaluation().yoy as number).toBeCloseTo(0.4, 2);
  });

  it("reports year-over-year as context without deciding for DID", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        treatedYearAgo: [
          constant("treated", 56, 200, yearAgoWeeks(ALL_WEEKS)),
        ],
        yearAgoCovered: true,
      }),
    );
    await run();
    expect(evaluation().method).toBe("DID");
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().yoy as number).toBeCloseTo(-0.5, 2);
  });

  it("passes the action id as the bootstrap seed (stable result)", async () => {
    await run();
    const first = evaluation();
    await run();
    expect(evaluation().low).toBe(first.low);
    expect(evaluation().high).toBe(first.high);
  });
});

describe("alert, CrUX, sitemap and launch", () => {
  const alertProposal = (kind: "TECH_FIX" | "CWV_FIX" | "SITEMAP_FIX") => ({
    ...proposalFixture(kind),
    alert: { kind: "SEO_X", dedupeKey: "seo:x", source: "SEO" as const },
  });

  it("evaluates an alert that stayed resolved as WORKED (DIRECTIONAL)", async () => {
    await run({
      kind: "TECH_FIX",
      source: "HEALTH_ISSUE",
      proposal: alertProposal("TECH_FIX"),
    });
    expect(evaluation().method).toBe("ALERT");
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().confidence).toBe("DIRECTIONAL");
    expect(mocks.series).not.toHaveBeenCalled();
    expect(mocks.alert.mock.calls[0]![0].where).toEqual({
      projectId_dedupeKey: { projectId: "project-1", dedupeKey: "seo:x" },
    });
  });

  it("evaluates a reopened alert as DIDNT and a deleted one as ALERT_GONE", async () => {
    mocks.alert.mockResolvedValue({ status: "OPEN" });
    await run({
      kind: "TECH_FIX",
      source: "HEALTH_ISSUE",
      proposal: alertProposal("TECH_FIX"),
    });
    expect(evaluation().outcome).toBe("DIDNT");
    mocks.alert.mockResolvedValue(null);
    await run({
      kind: "TECH_FIX",
      source: "HEALTH_ISSUE",
      proposal: alertProposal("TECH_FIX"),
    });
    expect(evaluation().outcome).toBe("INCONCLUSIVE");
    expect(evaluation().reason).toBe("ALERT_GONE");
  });

  it("adds CrUX numbers to an alert-sourced CWV fix", async () => {
    mocks.cwv.mockResolvedValue([
      {
        periodEnd: new Date("2026-09-30T00:00:00.000Z"),
        lcpP75: 2100,
        inpP75: null,
        clsP75: null,
      },
      {
        periodEnd: new Date("2026-07-30T00:00:00.000Z"),
        lcpP75: 4200,
        inpP75: null,
        clsP75: null,
      },
    ]);
    await run({
      kind: "CWV_FIX",
      source: "HEALTH_ISSUE",
      proposal: alertProposal("CWV_FIX"),
    });
    expect(evaluation().method).toBe("ALERT");
    expect(evaluation().cwv).toEqual({
      metric: "lcp",
      before: 4200,
      after: 2100,
    });
  });

  it("decides a CWV fix without an alert from CrUX p75", async () => {
    mocks.cwv.mockResolvedValue([
      {
        periodEnd: new Date("2026-09-30T00:00:00.000Z"),
        lcpP75: 2100,
        inpP75: null,
        clsP75: null,
      },
      {
        periodEnd: new Date("2026-07-30T00:00:00.000Z"),
        lcpP75: 4200,
        inpP75: null,
        clsP75: null,
      },
    ]);
    await run({ kind: "CWV_FIX", source: "HEALTH_ISSUE" });
    expect(evaluation().method).toBe("CRUX");
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().metric).toBe("cwv");
  });

  it("is NO_DATA for CrUX without a later period or when CrUX is off", async () => {
    mocks.cwv.mockResolvedValue([
      {
        periodEnd: new Date("2026-07-30T00:00:00.000Z"),
        lcpP75: 4200,
        inpP75: null,
        clsP75: null,
      },
    ]);
    await run({ kind: "CWV_FIX", source: "HEALTH_ISSUE" });
    expect(evaluation().reason).toBe("NO_DATA");
    delete process.env.GOOGLE_API_KEY;
    await run({ kind: "CWV_FIX", source: "HEALTH_ISSUE" });
    expect(evaluation().reason).toBe("NO_DATA");
    expect(mocks.cwv).toHaveBeenCalledTimes(1);
  });

  it("decides a sitemap fix from our own parse and the GSC error count", async () => {
    mocks.site.mockResolvedValue({
      id: "site-1",
      sitemaps: [{ status: 200 }],
    });
    mocks.gscSitemaps.mockResolvedValue([{ errors: 0 }, { errors: 0 }]);
    await run({ kind: "SITEMAP_FIX", source: "HEALTH_ISSUE" });
    expect(evaluation().method).toBe("SITEMAP");
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().sitemap).toEqual({
      errorsBefore: null,
      errorsAfter: 0,
      ownOk: true,
    });
    mocks.gscSitemaps.mockResolvedValue([{ errors: 3 }]);
    await run({ kind: "SITEMAP_FIX", source: "HEALTH_ISSUE" });
    expect(evaluation().outcome).toBe("DIDNT");
  });

  it("evaluates a launch from post-window visibility", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        treated: [
          build("treated", ALL_WEEKS, (week) => PRE.includes(week) ? { clicks: 0, impressions: 0 } : { clicks: 20, impressions: 200 }),
        ],
      }),
    );
    await run({ kind: "NEW_CONTENT", source: "SEO_MANAGER" });
    expect(evaluation().method).toBe("LAUNCH");
    expect(evaluation().outcome).toBe("WORKED");
    expect(evaluation().confidence).toBe("DIRECTIONAL");
    expect(mocks.series.mock.calls[0]![0].treatedOnly).toBe(true);
  });

  it("marks a launch with no impressions as DIDNT and a missing page the same way", async () => {
    mocks.series.mockResolvedValue(
      loaded({
        treated: [
          constant("treated", 0, 0),
        ],
      }),
    );
    await run({ kind: "LOCALIZE", source: "SEO_MANAGER" });
    expect(evaluation().outcome).toBe("DIDNT");
    mocks.series.mockResolvedValue({ missing: "NO_PAGE" });
    await run({ kind: "NEW_CONTENT", source: "SEO_MANAGER" });
    expect(evaluation().outcome).toBe("DIDNT");
  });

  it("is NO_PAGE for a launch without any target", async () => {
    await run({
      kind: "NEW_CONTENT",
      source: "SEO_MANAGER",
      targetUrl: null,
      pageId: null,
    });
    expect(evaluation().reason).toBe("NO_PAGE");
    expect(mocks.series).not.toHaveBeenCalled();
  });

  it("is NO_SEARCH_DATA for a launch without a link", async () => {
    await run({ kind: "NEW_CONTENT", source: "SEO_MANAGER", linkId: null });
    expect(evaluation().reason).toBe("NO_SEARCH_DATA");
  });
});

describe("write side effects", () => {
  it("marks the finding EVALUATED only from DONE and writes the audit entry", async () => {
    await run();
    expect(mocks.finding).toHaveBeenCalledWith({
      where: { id: "finding-1", projectId: "project-1", status: "DONE" },
      data: { status: "EVALUATED", outcome: "WORKED", evaluatedAt: NOW },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "seo_action.evaluated",
        entityId: "action-1",
        metadata: { kind: "TITLE_META", outcome: "WORKED", method: "DID" },
      }),
    );
  });

  it("does not touch findings for an action without one", async () => {
    await run({ findingId: null });
    expect(mocks.finding).not.toHaveBeenCalled();
  });

  it("calls the learning writer after the evaluation is written", async () => {
    await run();
    expect(mocks.writeFor).toHaveBeenCalledWith("action-1", NOW);
    expect(mocks.release.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.writeFor.mock.invocationCallOrder[0]!,
    );
  });

  it("survives a learning writer that throws", async () => {
    mocks.writeFor.mockRejectedValue(new Error("db"));
    expect((await run()).status).toBe("evaluated");
  });

  it("does not write side effects when the lease was lost", async () => {
    mocks.release.mockResolvedValue(false);
    expect((await run()).status).toBe("busy");
    expect(mocks.finding).not.toHaveBeenCalled();
    expect(mocks.writeFor).not.toHaveBeenCalled();
  });

  it("stores no Google strings: the evaluation holds only public update fields", async () => {
    await run();
    const text = JSON.stringify(evaluation());
    expect(text).not.toContain("http");
    expect(text).not.toContain("query");
  });
});
