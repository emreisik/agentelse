import type { GscSplitTest } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { seededRandom, type PageSeries } from "@/lib/seo/actions/did";
import { evaluationWindows } from "@/lib/seo/actions/windows";

// Bu dosyanın kanıtladığı: değerlendirme pencere hazır olana dek bekler
// (+24 saat), evaluateAfter + 21 günde INCONCLUSIVE NO_DATA yazar; eksik
// kapsama NO_DATA verir; başka eylemlerin dokunduğu sayfalar iki koldan da
// çıkar ve evaluation.excluded'a yazılır; sonuç alanları ve denetim kaydı
// yazılır; EVALUATING olmayan, vadesi gelmemiş ya da geliştirme korumasına
// takılan test atlanır.

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  link: vi.fn(),
  assignments: vi.fn(),
  actions: vi.fn(),
  pages: vi.fn(),
  updates: vi.fn(),
  engine: vi.fn(),
  series: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSplitTest: { findUnique: mocks.findUnique, updateMany: mocks.update },
    gscSiteLink: { findUnique: mocks.link },
    gscSplitTestPage: { findMany: mocks.assignments },
    seoAction: { findMany: mocks.actions },
    gscPage: { findMany: mocks.pages },
    searchUpdate: { findMany: mocks.updates },
    seoEngineState: { findUnique: mocks.engine },
  },
}));
vi.mock("./series", () => ({ loadArmSeries: mocks.series }));
vi.mock("@/server/seo/opportunities/state", async () => {
  const { priorCurve } = await import("@/lib/seo/ctr-curve");
  return { parseSeoCurves: () => ({ nonBrand: priorCurve("non-brand"), brand: priorCurve("brand") }) };
});
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: mocks.audit },
}));

const { evaluateSplitTest } = await import("./evaluate");

const MEASURE_FROM = new Date("2026-08-05T12:00:00.000Z");
const EVALUATE_AFTER = new Date("2026-09-02T12:00:00.000Z");
const NOW = new Date("2026-09-10T12:00:00.000Z");
const WINDOWS = evaluationWindows({ measureFrom: MEASURE_FROM, windowDays: 28 });
const ALL_WEEKS = [...WINDOWS.preWeeks, ...WINDOWS.postWeeks];

function row(over: Partial<GscSplitTest> = {}): GscSplitTest {
  return {
    id: "split-1",
    workspaceId: "ws-1",
    projectId: "project-1",
    linkId: "link-1",
    isMock: false,
    changeKind: "TITLE_META",
    status: "EVALUATING",
    seed: "split-1",
    testPages: 40,
    controlPages: 40,
    measureFrom: MEASURE_FROM,
    appliedAt: MEASURE_FROM,
    windowDays: 28,
    evaluateAfter: EVALUATE_AFTER,
    ...over,
  } as unknown as GscSplitTest;
}

function seriesFor(prefix: string, count: number, lift: number): PageSeries[] {
  const random = seededRandom(`s-${prefix}`);
  return Array.from({ length: count }, (_, index) => {
    const base = 10 + Math.floor(random() * 40);
    return {
      pageId: `${prefix}${index}`,
      weeks: ALL_WEEKS.map((weekStart, weekIndex) => {
        const post = weekIndex >= WINDOWS.preWeeks.length;
        const impressions = Math.round(base * 20 * (1 + (random() - 0.5) * 0.2));
        const clicks = Math.round(
          impressions * 0.05 * (1 + (random() - 0.5) * 1.2) * (post ? 1 + lift : 1),
        );
        return { weekStart, clicks, impressions, positionWeighted: impressions * 5 };
      }),
    };
  });
}

function assignment(count: number) {
  return [
    ...Array.from({ length: count }, (_, index) => ({ pageId: `t${index}`, arm: "TEST" })),
    ...Array.from({ length: count }, (_, index) => ({ pageId: `c${index}`, arm: "CONTROL" })),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENTELSE_PROVIDER_MODE", "");
  vi.stubEnv("NODE_ENV", "test");
  mocks.findUnique.mockResolvedValue(row());
  mocks.link.mockResolvedValue({ lastWeeklyWeek: WINDOWS.lastNeededWeek });
  mocks.assignments.mockResolvedValue(assignment(40));
  mocks.actions.mockResolvedValue([]);
  mocks.pages.mockResolvedValue([]);
  mocks.updates.mockResolvedValue([]);
  mocks.engine.mockResolvedValue({ curves: null });
  mocks.series.mockResolvedValue({
    test: seriesFor("t", 40, 0.3),
    control: seriesFor("c", 40, 0),
    coveredWeeks: new Set(ALL_WEEKS),
    truncated: false,
  });
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.audit.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function written() {
  return mocks.update.mock.calls.at(-1)?.[0] as {
    where: unknown;
    data: Record<string, unknown> & { evaluation: { reason: string | null; excluded: number } };
  };
}

describe("evaluateSplitTest", () => {
  it("writes the outcome fields and an audit record", async () => {
    expect(await evaluateSplitTest("split-1", NOW)).toBe("evaluated");
    const { where, data } = written();
    expect(where).toEqual({ id: "split-1", status: "EVALUATING" });
    expect(data.status).toBe(data.outcome);
    expect(["WORKED", "INCONCLUSIVE"]).toContain(data.outcome);
    expect(data.evaluatedAt).toEqual(NOW);
    expect(data.nextCheckAt).toBeNull();
    expect(data.confidence).toBe("DIRECTIONAL");
    expect(data.evaluation).toMatchObject({ v: 1, method: "DID", usedTest: 40, usedControl: 40 });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0]?.[0]).toMatchObject({
      action: "gsc_split_test.evaluated",
      entityType: "GscSplitTest",
      entityId: "split-1",
      metadata: { kind: "TITLE_META" },
    });
  });

  it("builds the windows from measureFrom and loads both arms", async () => {
    await evaluateSplitTest("split-1", NOW);
    const call = mocks.series.mock.calls[0]?.[0];
    expect(call.weeks).toEqual(ALL_WEEKS);
    expect(call.testIds).toHaveLength(40);
    expect(call.controlIds).toHaveLength(40);
  });

  it("waits until the warehouse reached the last needed week", async () => {
    mocks.link.mockResolvedValue({ lastWeeklyWeek: WINDOWS.preWeeks[0] });
    expect(await evaluateSplitTest("split-1", NOW)).toBe("waiting");
    expect(mocks.update.mock.calls[0]?.[0].data.nextCheckAt).toEqual(
      new Date(NOW.getTime() + 86_400_000),
    );
    expect(mocks.series).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("gives up 21 days after evaluateAfter", async () => {
    mocks.link.mockResolvedValue({ lastWeeklyWeek: WINDOWS.preWeeks[0] });
    const late = new Date(EVALUATE_AFTER.getTime() + 21 * 86_400_000);
    expect(await evaluateSplitTest("split-1", late)).toBe("evaluated");
    const { data } = written();
    expect(data.outcome).toBe("INCONCLUSIVE");
    expect(data.evaluation.reason).toBe("NO_DATA");
  });

  it("reports NO_DATA when the weeks are not covered", async () => {
    mocks.series.mockResolvedValue({
      test: [],
      control: [],
      coveredWeeks: new Set(WINDOWS.preWeeks.slice(0, 2)),
      truncated: false,
    });
    expect(await evaluateSplitTest("split-1", NOW)).toBe("evaluated");
    expect(written().data.evaluation.reason).toBe("NO_DATA");
  });

  it("leaves out CMS test pages that never got a change", async () => {
    mocks.findUnique.mockResolvedValue(
      row({
        appliedVia: "CMS",
        cmsChanges: {
          v: 1,
          items: [
            { pageId: "t0", changeId: "c0", skipped: null },
            { pageId: "t4", changeId: null, skipped: "TOO_LONG" },
            { pageId: "t5", changeId: null, skipped: "FAILED" },
          ],
        } as never,
      }),
    );
    await evaluateSplitTest("split-1", NOW);
    const call = mocks.series.mock.calls[0]?.[0];
    expect(call.testIds).toContain("t0");
    expect(call.testIds).not.toContain("t4");
    expect(call.testIds).not.toContain("t5");
    expect(written().data.evaluation.excluded).toBe(2);
  });

  it("ignores the CMS item list on manual tests", async () => {
    mocks.findUnique.mockResolvedValue(
      row({
        appliedVia: "MANUAL",
        cmsChanges: { v: 1, items: [{ pageId: "t4", changeId: null, skipped: "TOO_LONG" }] } as never,
      }),
    );
    await evaluateSplitTest("split-1", NOW);
    expect(mocks.series.mock.calls[0]?.[0].testIds).toContain("t4");
  });

  it("leaves out pages that other actions touched in the window", async () => {
    mocks.actions.mockResolvedValue([
      { pageId: "t1", targetUrl: null, appliedAt: new Date("2026-08-20T12:00:00.000Z") },
      { pageId: "c2", targetUrl: null, appliedAt: new Date("2026-08-21T12:00:00.000Z") },
      { pageId: "t3", targetUrl: null, appliedAt: new Date("2025-01-01T12:00:00.000Z") },
    ]);
    mocks.pages.mockResolvedValue([]);
    await evaluateSplitTest("split-1", NOW);
    const call = mocks.series.mock.calls[0]?.[0];
    expect(call.testIds).not.toContain("t1");
    expect(call.controlIds).not.toContain("c2");
    expect(call.testIds).toContain("t3");
    expect(written().data.evaluation.excluded).toBe(2);
  });

  it("reports LOW_DATA when an arm drops below 20 usable pages", async () => {
    mocks.series.mockResolvedValue({
      test: seriesFor("t", 10, 0.3),
      control: seriesFor("c", 40, 0),
      coveredWeeks: new Set(ALL_WEEKS),
      truncated: false,
    });
    await evaluateSplitTest("split-1", NOW);
    expect(written().data.evaluation.reason).toBe("LOW_DATA");
  });

  it("caps the result when a ranking update overlapped", async () => {
    mocks.updates.mockResolvedValue([
      { name: "Core update", kind: "CORE", startedAt: new Date("2026-08-12T00:00:00.000Z"), endedAt: null },
    ]);
    await evaluateSplitTest("split-1", NOW);
    const { data } = written();
    expect(data.outcome).toBe("INCONCLUSIVE");
    expect(data.evaluation.reason).toBe("GOOGLE_UPDATE");
  });

  it("skips tests that are not evaluating, from another mode or blocked in dev", async () => {
    mocks.findUnique.mockResolvedValue(row({ status: "APPLIED" }));
    expect(await evaluateSplitTest("split-1", NOW)).toBe("skipped");
    mocks.findUnique.mockResolvedValue(row({ isMock: true }));
    expect(await evaluateSplitTest("split-1", NOW)).toBe("skipped");
    mocks.findUnique.mockResolvedValue(null);
    expect(await evaluateSplitTest("split-1", NOW)).toBe("skipped");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com:5432/live");
    vi.stubEnv("GSC_SYNC_DEV_PROJECTS", "");
    vi.stubEnv("GSC_ROLLOUT_PROJECTS", "");
    mocks.findUnique.mockResolvedValue(row());
    expect(await evaluateSplitTest("split-1", NOW)).toBe("skipped");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("waits when evaluateAfter has not arrived", async () => {
    mocks.findUnique.mockResolvedValue(row({ evaluateAfter: new Date(NOW.getTime() + 86_400_000) }));
    expect(await evaluateSplitTest("split-1", NOW)).toBe("waiting");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does nothing when another worker finished first", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    expect(await evaluateSplitTest("split-1", NOW)).toBe("skipped");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
