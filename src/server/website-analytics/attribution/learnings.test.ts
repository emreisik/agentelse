import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bu dosyanın kanıtladığı: öğrenme işi bayrak kapalıyken sorgusuz 0 döner;
// üretimde claimPeriodic'e, yerelde süreç içi kısmaya ve geliştirme
// listesine uyar; projeler güne göre döner; runProject mock bağ, kritik ölçüm
// sorunu, şüpheli gün ve var olan öğrenme için doğru davranır.

const mocks = vi.hoisted(() => ({
  claimPeriodic: vi.fn(),
  groupBy: vi.fn(),
  linkFindMany: vi.fn(),
  learningFindFirst: vi.fn(),
  learningCreate: vi.fn(),
  brandFindFirst: vi.fn(),
  primaryGaLink: vi.fn(),
  gaDataThrough: vi.fn(),
  readDailyTotals: vi.fn(),
  attributeWindow: vi.fn(),
  summary: vi.fn(),
  suspectDays: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    trackedLink: { groupBy: mocks.groupBy },
    gaPropertyLink: { findMany: mocks.linkFindMany },
    brandLearning: {
      findFirst: mocks.learningFindFirst,
      create: mocks.learningCreate,
    },
    brand: { findFirst: mocks.brandFindFirst },
  },
}));
vi.mock("@/server/observability/periodic", () => ({
  claimPeriodic: mocks.claimPeriodic,
}));
vi.mock("@/server/website-analytics/store", () => ({
  primaryGaLink: mocks.primaryGaLink,
  gaDataThrough: mocks.gaDataThrough,
  readDailyTotals: mocks.readDailyTotals,
}));
vi.mock("@/server/website-analytics/attribution/data", () => ({
  attributeWindow: mocks.attributeWindow,
}));
vi.mock("@/server/website-analytics/health/read", () => ({
  loadMeasurementSummaryForLink: mocks.summary,
  readGaSuspectDays: mocks.suspectDays,
}));

import { addDays } from "@/lib/website-analytics/days";

import { GaAttributionLearnings } from "./learnings";

const NOW = new Date("2026-10-05T10:00:00Z");
const DAY_MS = 86_400_000;
const FINAL = "2026-09-28";
const FROM = addDays(FINAL, -27);

function metrics(sessions: number, keyEvents: number) {
  return {
    sessions,
    engagedSessions: Math.round(sessions * 0.6),
    keyEvents,
    revenue: 0,
  };
}

function groupResult(sessions: number, keyEvents: number) {
  const figures = metrics(sessions, keyEvents);
  return {
    key: "meta:cmp1",
    kind: "meta_campaign",
    entityType: "meta_ad",
    channel: "meta_ads",
    label: "Spring Sale",
    campaignExternalId: "cmp1",
    linkIds: [],
    adExternalIds: [],
    metrics: figures,
    adMetrics: figures,
  };
}

// 28 gün, günde 100 oturum / 8 key event.
function siteDays() {
  return Array.from({ length: 28 }, (_, index) => ({
    day: addDays(FROM, index),
    sessions: 100,
    engagedSessions: 60,
    keyEvents: 8,
    revenueMicros: BigInt(0),
  }));
}

function arrange(group = groupResult(1400, 168)) {
  mocks.primaryGaLink.mockImplementation(async (projectId: string) => ({
    id: `link-${projectId}`,
    workspaceId: "ws1",
    isMock: false,
  }));
  mocks.summary.mockResolvedValue(null);
  mocks.gaDataThrough.mockResolvedValue({ through: FINAL, finalThrough: FINAL });
  mocks.suspectDays.mockResolvedValue(new Map());
  mocks.attributeWindow.mockResolvedValue({
    result: { groups: [group] },
    window: { rows: [], days: 28, coveredDays: 28, truncated: false },
    links: [],
    legacy: [],
  });
  mocks.readDailyTotals.mockResolvedValue(siteDays());
  mocks.learningFindFirst.mockResolvedValue(null);
  mocks.brandFindFirst.mockResolvedValue({ id: "brand1" });
  mocks.learningCreate.mockResolvedValue({});
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  vi.stubEnv("GA_UTM", "true");
  vi.stubEnv("GA_SYNC", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("GaAttributionLearnings.runProject", () => {
  it("writes one number-free learning for a group that passes the gate", async () => {
    arrange();
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(1);
    expect(mocks.attributeWindow).toHaveBeenCalledWith({
      projectId: "p1",
      linkId: "link-p1",
      range: { from: FROM, to: FINAL },
      exclude: new Set<string>(),
    });
    expect(mocks.learningCreate).toHaveBeenCalledTimes(1);
    const data = mocks.learningCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "ws1",
      projectId: "p1",
      brandId: "brand1",
      sourceType: "GA4",
      sourceRef: "ga-utm:meta:cmp1",
      polarity: "WORKS",
      confidence: 0.8,
      lastReinforcedAt: NOW,
    });
    expect(data.insight).toMatch(/^[^0-9]*$/);
    expect(data.insight).toContain("clearly more often");
  });

  it("writes nothing when the learning already exists", async () => {
    arrange();
    mocks.learningFindFirst.mockResolvedValue({ id: "old" });
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
    expect(mocks.learningCreate).not.toHaveBeenCalled();
    expect(mocks.learningFindFirst).toHaveBeenCalledWith({
      where: {
        projectId: "p1",
        sourceType: "GA4",
        sourceRef: "ga-utm:meta:cmp1",
      },
      select: { id: true },
    });
  });

  it("writes nothing when the project has no default brand", async () => {
    arrange();
    mocks.brandFindFirst.mockResolvedValue(null);
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
    expect(mocks.learningCreate).not.toHaveBeenCalled();
  });

  it("skips a mock link without reading the warehouse", async () => {
    arrange();
    mocks.primaryGaLink.mockResolvedValue({
      id: "l",
      workspaceId: "ws1",
      isMock: true,
    });
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
    expect(mocks.attributeWindow).not.toHaveBeenCalled();
  });

  it("skips a project with a critical measurement problem", async () => {
    arrange();
    mocks.summary.mockResolvedValue({ critical: 1 });
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
    expect(mocks.attributeWindow).not.toHaveBeenCalled();
  });

  it("skips a project without final days", async () => {
    arrange();
    mocks.gaDataThrough.mockResolvedValue({ through: FINAL, finalThrough: null });
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
  });

  it("removes suspect days from the attribution and from the site totals", async () => {
    arrange();
    const suspect = addDays(FINAL, -2);
    mocks.suspectDays.mockResolvedValue(new Map([[suspect, ["MH1"]]]));
    await GaAttributionLearnings.runProject("p1", NOW);
    const input = mocks.attributeWindow.mock.calls[0]![0];
    expect([...input.exclude]).toEqual([suspect]);
    expect(mocks.suspectDays).toHaveBeenCalledWith("link-p1", FROM, FINAL);

    // Şüpheli günün (çarpık) site toplamı hesaba girmez: kalan 27 günde grup
    // sitenin geri kalanıyla aynı oranda, öğrenme çıkmaz.
    mocks.learningCreate.mockClear();
    mocks.attributeWindow.mockResolvedValue({
      result: { groups: [groupResult(1350, 108)] },
      window: { rows: [], days: 28, coveredDays: 27, truncated: false },
      links: [],
      legacy: [],
    });
    mocks.readDailyTotals.mockResolvedValue(
      siteDays().map((row) =>
        row.day === suspect
          ? { ...row, sessions: 5000, keyEvents: 0 }
          : row,
      ),
    );
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);

    // Aynı veri şüpheli gün işaretsiz olsa öğrenme üretirdi.
    mocks.suspectDays.mockResolvedValue(new Map());
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(1);
  });

  it("is off when the flag is off", async () => {
    arrange();
    vi.stubEnv("GA_UTM", "");
    expect(await GaAttributionLearnings.runProject("p1", NOW)).toBe(0);
    expect(mocks.primaryGaLink).not.toHaveBeenCalled();
  });
});

describe("GaAttributionLearnings.runDue", () => {
  it("returns 0 without any query when GA_UTM is off", async () => {
    vi.stubEnv("GA_UTM", "");
    expect(await GaAttributionLearnings.runDue(200, NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("returns 0 without any query when GA_SYNC is off", async () => {
    vi.stubEnv("GA_SYNC", "");
    expect(await GaAttributionLearnings.runDue(200, NOW)).toBe(0);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("does nothing when the daily claim is not won", async () => {
    mocks.claimPeriodic.mockResolvedValue(false);
    expect(await GaAttributionLearnings.runDue(200, NOW)).toBe(0);
    expect(mocks.claimPeriodic).toHaveBeenCalledWith(
      "ga.attribution.learnings",
      DAY_MS,
      NOW,
    );
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("only considers projects with a live non-mock primary link", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    mocks.groupBy.mockResolvedValue([{ projectId: "b" }, { projectId: "a" }]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "a" }]);
    arrange();
    await GaAttributionLearnings.runDue(200, NOW);
    expect(mocks.linkFindMany).toHaveBeenCalledWith({
      where: {
        projectId: { in: ["b", "a"] },
        isPrimary: true,
        isMock: false,
        health: {
          notIn: ["AUTH", "NEEDS_PERMISSION", "ACCESS_LOST", "GONE", "API_DISABLED"],
        },
      },
      select: { projectId: true },
    });
    expect(mocks.primaryGaLink).toHaveBeenCalledTimes(1);
    expect(mocks.primaryGaLink).toHaveBeenCalledWith("a");
  });

  it("rotates the projects by day so none starves", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    mocks.groupBy.mockResolvedValue([{ projectId: "a" }, { projectId: "b" }]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "a" }, { projectId: "b" }]);
    arrange();

    const processed: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      mocks.primaryGaLink.mockClear();
      await GaAttributionLearnings.runDue(1, new Date(NOW.getTime() + day * DAY_MS));
      expect(mocks.primaryGaLink).toHaveBeenCalledTimes(1);
      processed.push(mocks.primaryGaLink.mock.calls[0]![0] as string);
    }
    expect(processed[0]).not.toBe(processed[1]);
    expect(processed[1]).not.toBe(processed[2]);
    expect(new Set(processed)).toEqual(new Set(["a", "b"]));
  });

  it("goes on with the next project when one throws", async () => {
    mocks.claimPeriodic.mockResolvedValue(true);
    mocks.groupBy.mockResolvedValue([{ projectId: "a" }, { projectId: "b" }]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "a" }, { projectId: "b" }]);
    arrange();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.primaryGaLink.mockImplementation(async (projectId: string) => {
      if (projectId === "a") throw new Error("secret detail");
      return { id: `link-${projectId}`, workspaceId: "ws1", isMock: false };
    });
    expect(await GaAttributionLearnings.runDue(200, NOW)).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("secret detail");
    warn.mockRestore();
  });

  it("in a shared development process acts only on listed projects, without a heartbeat", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com:5432/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "a, c");
    mocks.groupBy.mockResolvedValue([{ projectId: "a" }]);
    mocks.linkFindMany.mockResolvedValue([{ projectId: "a" }]);
    arrange();

    const later = new Date("2026-10-06T10:00:00Z");
    expect(await GaAttributionLearnings.runDue(200, later)).toBe(1);
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
    expect(mocks.groupBy).toHaveBeenCalledWith({
      by: ["projectId"],
      where: { projectId: { in: ["a", "c"] } },
    });

    // 30 dakikalık süreç içi kısma.
    mocks.groupBy.mockClear();
    const soon = new Date(later.getTime() + 10 * 60_000);
    expect(await GaAttributionLearnings.runDue(200, soon)).toBe(0);
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("in a development process with an empty list does nothing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pw@db.example.com:5432/live");
    vi.stubEnv("GA_SYNC_DEV_PROJECTS", "");
    expect(
      await GaAttributionLearnings.runDue(200, new Date("2026-10-07T10:00:00Z")),
    ).toBe(0);
    expect(mocks.groupBy).not.toHaveBeenCalled();
    expect(mocks.claimPeriodic).not.toHaveBeenCalled();
  });
});
