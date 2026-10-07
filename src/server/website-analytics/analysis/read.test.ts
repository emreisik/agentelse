import type { GaFinding } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { An1Evidence } from "@/lib/website-analytics/analysis/types";

// Bu dosyanın kanıtladığı: findingViewOf satırı görünüme çevirir, okunamayan
// kanıtı reddeder; loadWebsiteInsights kapalıyken ve gölge modda operatör
// olmayana sorgusuz null döner; operatör kartının son bulgular sorgusu yalnız
// üye projelerle sınırlıdır ve konu/kanıt/açıklama seçmez.

const db = vi.hoisted(() => ({
  gaFinding: {
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
  gaAnalysisRun: { count: vi.fn() },
  gaPropertyLink: { count: vi.fn() },
  project: { findMany: vi.fn() },
}));
const deps = vi.hoisted(() => ({
  primaryGaLink: vi.fn(),
  isPlatformOperator: vi.fn(),
  heartbeatRead: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: deps.primaryGaLink,
}));
vi.mock("@/server/security/operator", () => ({
  isPlatformOperator: deps.isPlatformOperator,
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { read: deps.heartbeatRead },
}));

const { findingViewOf, loadGaInsightsOperatorView, loadWebsiteInsights } =
  await import("./read");

const NOW = new Date("2026-10-07T10:00:00.000Z");

const EVIDENCE: An1Evidence = {
  v: 1,
  rule: "AN1",
  mode: "day",
  target: "2026-10-05",
  readings: [
    {
      metric: "sessions",
      value: 120,
      median: 400,
      scale: 40,
      z: -7,
      direction: "down",
      baselineDays: ["2026-09-28"],
    },
  ],
  primary: "sessions",
  excludedDays: [],
  breakdown: null,
  seasonalChecked: true,
  preliminary: true,
};

function row(partial: Partial<GaFinding> = {}): GaFinding {
  return {
    id: "f-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    linkId: "link-1",
    ruleKey: "AN1",
    ruleVersion: 1,
    kind: "ANOMALY",
    subject: "site",
    subjectKey: "0123456789abcdef",
    periodGrain: "DAY",
    periodKey: "2026-10-05",
    periodStart: new Date("2026-10-05T00:00:00.000Z"),
    periodEnd: new Date("2026-10-05T00:00:00.000Z"),
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    isMock: false,
    priority: 1.5,
    evidence: EVIDENCE as unknown as GaFinding["evidence"],
    impact: null,
    explanation: null,
    explainedAt: null,
    rank: null,
    fingerprint: "link-1:AN1:0123456789abcdef:2026-10-05",
    previousId: null,
    occurrences: 1,
    signalId: null,
    ideaIds: [],
    acceptedAt: null,
    acceptedByUserId: null,
    dismissedAt: null,
    dismissedByUserId: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    outcomeEvidence: null,
    closedReason: null,
    closedAt: null,
    reviewVerdict: null,
    reviewedAt: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-10-06T09:00:00.000Z"),
    updatedAt: new Date("2026-10-06T09:00:00.000Z"),
    ...partial,
  };
}

function allDbMocks() {
  return Object.values(db).flatMap((model) => Object.values(model));
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("GA_SYNC", "true");
  vi.stubEnv("GA_INSIGHTS_PROJECTS", "");
  for (const mock of [...allDbMocks(), ...Object.values(deps)])
    mock.mockReset();
  deps.isPlatformOperator.mockReturnValue(false);
  deps.heartbeatRead.mockResolvedValue(null);
});

describe("findingViewOf", () => {
  it("maps a stored row to a view", () => {
    const view = findingViewOf(row());
    expect(view).toMatchObject({
      id: "f-1",
      ruleKey: "AN1",
      kind: "ANOMALY",
      subject: "site",
      period: {
        grain: "DAY",
        from: "2026-10-05",
        to: "2026-10-05",
        key: "2026-10-05",
      },
      status: "OPEN",
      mode: "live",
      evaluable: false,
      preliminary: true,
      createdAt: "2026-10-06T09:00:00.000Z",
      outcome: null,
    });
    expect(view?.subjectLabel).toEqual(expect.any(String));
  });

  it("rejects unreadable evidence and unknown rule keys", () => {
    expect(findingViewOf(row({ evidence: { v: 2 } }))).toBeNull();
    expect(findingViewOf(row({ ruleKey: "AN16" }))).toBeNull();
    expect(findingViewOf(row({ status: "WHATEVER" }))).toBeNull();
  });
});

describe("loadWebsiteInsights", () => {
  it("returns null without a query when GA_INSIGHTS is off", async () => {
    vi.stubEnv("GA_INSIGHTS", "off");
    deps.isPlatformOperator.mockReturnValue(true);
    expect(
      await loadWebsiteInsights("proj-1", { userId: "u-1", review: true }, NOW),
    ).toBeNull();
    expect(deps.primaryGaLink).not.toHaveBeenCalled();
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("returns null without a query in shadow mode for a non-operator", async () => {
    vi.stubEnv("GA_INSIGHTS", "shadow");
    expect(
      await loadWebsiteInsights("proj-1", { userId: "u-1", review: true }, NOW),
    ).toBeNull();
    expect(deps.primaryGaLink).not.toHaveBeenCalled();
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("splits open live findings into the two lists when on", async () => {
    vi.stubEnv("GA_INSIGHTS", "on");
    deps.primaryGaLink.mockResolvedValue({
      id: "link-1",
      timeZone: "Europe/Istanbul",
      currencyCode: "EUR",
    });
    db.gaFinding.findMany
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([]);
    const view = await loadWebsiteInsights(
      "proj-1",
      { userId: "u-1", review: false },
      NOW,
    );
    expect(view).toMatchObject({
      review: false,
      timeZone: "Europe/Istanbul",
      currency: "EUR",
      opportunities: [],
      inProgress: [],
    });
    expect(view?.changed.map((f) => f.id)).toEqual(["f-1"]);
    const openQuery = db.gaFinding.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(openQuery.where).toMatchObject({
      linkId: "link-1",
      status: "OPEN",
      mode: { in: ["live"] },
    });
  });
});

describe("loadGaInsightsOperatorView", () => {
  it("returns null without a query when GA_INSIGHTS is off", async () => {
    vi.stubEnv("GA_INSIGHTS", "off");
    expect(await loadGaInsightsOperatorView({ userId: "u-1" }, NOW)).toBeNull();
    for (const mock of allDbMocks()) expect(mock).not.toHaveBeenCalled();
  });

  it("restricts recent findings to member projects and selects no subject or evidence", async () => {
    vi.stubEnv("GA_INSIGHTS", "shadow");
    db.project.findMany.mockResolvedValue([{ id: "proj-1", name: "Acme" }]);
    db.gaFinding.groupBy.mockImplementation((args: { by: string[] }) => {
      if (args.by[0] === "mode") {
        return Promise.resolve([{ mode: "shadow", _count: { _all: 4 } }]);
      }
      if (args.by[0] === "reviewVerdict") {
        return Promise.resolve([
          { reviewVerdict: "USEFUL", _count: { _all: 3 } },
          { reviewVerdict: "NOT_USEFUL", _count: { _all: 1 } },
        ]);
      }
      return Promise.resolve([{ ruleKey: "AN3", _count: { _all: 4 } }]);
    });
    db.gaFinding.count.mockResolvedValue(2);
    db.gaAnalysisRun.count.mockResolvedValue(1);
    db.gaPropertyLink.count.mockResolvedValue(3);
    db.gaFinding.findMany.mockResolvedValue([
      {
        id: "f-1",
        projectId: "proj-1",
        ruleKey: "AN3",
        kind: "OPPORTUNITY",
        confidence: "DIRECTIONAL",
        mode: "shadow",
        createdAt: NOW,
        reviewVerdict: null,
      },
    ]);
    const view = await loadGaInsightsOperatorView({ userId: "u-1" }, NOW);
    const memberQuery = db.project.findMany.mock.calls[0]?.[0] as {
      where: unknown;
    };
    expect(memberQuery.where).toEqual({
      workspace: { members: { some: { userId: "u-1" } } },
    });
    const recentQuery = db.gaFinding.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };
    expect(recentQuery.where).toEqual({ projectId: { in: ["proj-1"] } });
    expect(recentQuery.select.subject).toBeUndefined();
    expect(recentQuery.select.evidence).toBeUndefined();
    expect(recentQuery.select.explanation).toBeUndefined();
    expect(view?.counters).toMatchObject({
      openShadow: 4,
      openLive: 0,
      reviewed: 4,
      useful: 3,
      notUseful: 1,
      precision: 0.75,
      linksAnalyzed: 1,
      linksDue: 2,
      lastRunMinutesAgo: null,
      byRule: [{ ruleKey: "AN3", open: 4 }],
    });
    expect(view?.recent).toEqual([
      {
        id: "f-1",
        projectId: "proj-1",
        projectName: "Acme",
        ruleKey: "AN3",
        kind: "OPPORTUNITY",
        confidence: "DIRECTIONAL",
        mode: "shadow",
        createdAt: NOW.toISOString(),
        verdict: null,
      },
    ]);
  });

  it("counts AN13 and AN14 per rule only while GA_UTM is on", async () => {
    vi.stubEnv("GA_INSIGHTS", "on");
    db.project.findMany.mockResolvedValue([]);
    db.gaFinding.groupBy.mockImplementation((args: { by: string[] }) =>
      Promise.resolve(
        args.by[0] === "ruleKey"
          ? [
              { ruleKey: "AN3", _count: { _all: 2 } },
              { ruleKey: "AN13", _count: { _all: 5 } },
              { ruleKey: "AN14", _count: { _all: 1 } },
            ]
          : [],
      ),
    );
    db.gaFinding.count.mockResolvedValue(0);
    db.gaAnalysisRun.count.mockResolvedValue(0);
    db.gaPropertyLink.count.mockResolvedValue(0);

    vi.stubEnv("GA_UTM", "");
    const off = await loadGaInsightsOperatorView({ userId: "u-1" }, NOW);
    expect(off?.counters.byRule).toEqual([{ ruleKey: "AN3", open: 2 }]);

    vi.stubEnv("GA_UTM", "true");
    const on = await loadGaInsightsOperatorView({ userId: "u-1" }, NOW);
    expect(on?.counters.byRule).toEqual([
      { ruleKey: "AN13", open: 5 },
      { ruleKey: "AN3", open: 2 },
      { ruleKey: "AN14", open: 1 },
    ]);
  });

  it("does not query findings of other projects when the viewer has none", async () => {
    vi.stubEnv("GA_INSIGHTS", "on");
    db.project.findMany.mockResolvedValue([]);
    db.gaFinding.groupBy.mockResolvedValue([]);
    db.gaFinding.count.mockResolvedValue(0);
    db.gaAnalysisRun.count.mockResolvedValue(0);
    db.gaPropertyLink.count.mockResolvedValue(0);
    const view = await loadGaInsightsOperatorView({ userId: "u-1" }, NOW);
    expect(db.gaFinding.findMany).not.toHaveBeenCalled();
    expect(view?.recent).toEqual([]);
    expect(view?.counters.reviewable).toBe(0);
  });
});
