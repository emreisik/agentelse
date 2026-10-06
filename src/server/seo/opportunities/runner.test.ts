import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GscSiteLink, SeoEngineState } from "@prisma/client";

// Bu dosyanın kanıtladığı: bayrak kapalıyken hiçbir sorgu yok; izin listesi
// boşsa 0; geliştirme süreci nabız yazmaz ve yalnız izinli projelere bakar;
// kilit doluysa busy; aynı hafta ve aynı kipte haftalık aşama çalışmaz, kip
// değişimi (shadow → on) onu zorlar; haftalık aşamanın sırası; anlık görüntü
// yoksa no_data ve lastWeek ilerlemez; çıktılar yalnız "on" kipinde ve
// haftalık olmayan koşularda da çalışır; bütçe aşımı llmSkipped'e yazılır;
// hata geri çekilmesi.

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  linkFindMany: vi.fn(),
  linkFindUnique: vi.fn(),
  projects: vi.fn(),
  beat: vi.fn(),
  ok: vi.fn(),
  ensure: vi.fn(),
  defer: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  scope: vi.fn(),
  classify: vi.fn(),
  embed: vi.fn(),
  curves: vi.fn(),
  refresh: vi.fn(),
  readClusters: vi.fn(),
  snapshot: vi.fn(),
  evaluate: vi.fn(),
  persist: vi.fn(),
  publish: vi.fn(),
  suggest: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    gscSiteLink: {
      findMany: mocks.linkFindMany,
      findUnique: mocks.linkFindUnique,
    },
    project: { findMany: mocks.projects },
  },
}));
vi.mock("@/server/observability/heartbeat", () => ({
  Heartbeat: { beat: mocks.beat, ok: mocks.ok },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: () => true,
}));
vi.mock("@/lib/seo/rules", () => ({ evaluateSeoRules: mocks.evaluate }));
vi.mock("./state", () => ({
  ENGINE_RECHECK_MS: 21_600_000,
  ENGINE_RUN_BUDGET_MS: 60_000,
  ENGINE_CONTINUE_MS: 120_000,
  ensureEngineState: mocks.ensure,
  deferEngineState: mocks.defer,
  claimEngineLease: mocks.claim,
  releaseEngineLease: mocks.release,
  parseSeoCurves: (value: unknown) => value,
}));
vi.mock("./classify", () => ({
  classifyQueries: mocks.classify,
  scopeForProject: mocks.scope,
}));
vi.mock("./embeddings", () => ({ embedPendingQueries: mocks.embed }));
vi.mock("./curve", () => ({ fitAndStoreCurves: mocks.curves }));
vi.mock("./clusters", () => ({
  refreshClusters: mocks.refresh,
  readClusters: mocks.readClusters,
}));
vi.mock("./snapshot", () => ({ loadRuleSnapshot: mocks.snapshot }));
vi.mock("./findings-store", () => ({ persistFindings: mocks.persist }));
vi.mock("./outputs", () => ({
  publishOpportunityOutputs: mocks.publish,
  maybeSuggestBrandTerms: mocks.suggest,
}));

const { SeoOpportunities, engineBackoffMs } = await import("./runner");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const WEEK = "2026-09-21";
const ENV_KEYS = [
  "SEO_INSIGHTS",
  "GSC_SYNC",
  "NODE_ENV",
  "DATABASE_URL",
  "GSC_SYNC_DEV_PROJECTS",
  "GSC_ROLLOUT_PROJECTS",
] as const;
const saved: Record<string, string | undefined> = {};
// NODE_ENV salt okunur tiplidir; testte ortam yazılabilir kayıt olarak ele alınır.
const env = process.env as Record<string, string | undefined>;

const LINK = {
  id: "link-1",
  projectId: "p1",
  workspaceId: "w1",
  isPrimary: true,
  isMock: true,
  lastWeeklyWeek: WEEK,
  brandTerms: null,
  brandClassifiedHash: null,
} as unknown as GscSiteLink;

function state(overrides: Partial<SeoEngineState> = {}): SeoEngineState {
  return {
    id: "state-1",
    linkId: "link-1",
    lastWeek: null,
    lastRunStats: null,
    curves: null,
    curvesWeek: null,
    clustersWeek: null,
    intentBrandHash: null,
    consecutiveFailures: 0,
    ...overrides,
  } as unknown as SeoEngineState;
}

const RUN = {
  drafts: [],
  evaluated: ["SO1_STRIKING_DISTANCE"],
  seen: [],
  skipped: [],
  fired: {},
  lowData: false,
  dropped: 0,
};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function lastRelease(): Record<string, unknown> {
  const calls = mocks.release.mock.calls;
  return calls[calls.length - 1]?.[2] as Record<string, unknown>;
}

function track(name: string, value: unknown) {
  return async () => {
    mocks.order.push(name);
    return value;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  setEnv({ SEO_INSIGHTS: "shadow", GSC_SYNC: "true", NODE_ENV: "test" });
  mocks.linkFindMany.mockResolvedValue([
    { id: "link-1", projectId: "p1", workspaceId: "w1", isMock: true },
  ]);
  mocks.linkFindUnique.mockResolvedValue(LINK);
  mocks.projects.mockResolvedValue([{ id: "p1", status: "ACTIVE" }]);
  mocks.ensure.mockResolvedValue(state());
  mocks.defer.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.scope.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    brandId: "b1",
  });
  mocks.classify.mockImplementation(
    track("classify", { classified: 0, llmCalls: 0, budgetHit: false }),
  );
  mocks.embed.mockImplementation(
    track("embed", { embedded: 2, budgetHit: false }),
  );
  mocks.curves.mockImplementation(track("curves", { nonBrand: {}, brand: {} }));
  mocks.refresh.mockImplementation(
    track("clusters", { clusters: 1, named: 0, budgetHit: false }),
  );
  mocks.readClusters.mockImplementation(track("readClusters", []));
  mocks.snapshot.mockImplementation(track("snapshot", { week: WEEK }));
  mocks.evaluate.mockImplementation(() => {
    mocks.order.push("rules");
    return RUN;
  });
  mocks.persist.mockImplementation(
    track("persist", {
      created: [],
      updated: 0,
      touched: 0,
      superseded: 0,
      resolved: 0,
      expired: 0,
      suppressed: 0,
    }),
  );
  mocks.publish.mockImplementation(
    track("publish", { explained: 0, signals: 0, budgetHit: false }),
  );
  mocks.suggest.mockImplementation(
    track("suggest", { ran: false, budgetHit: false }),
  );
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

describe("SeoOpportunities.runDue", () => {
  it("returns 0 with no database call when the flag is off", async () => {
    setEnv({ SEO_INSIGHTS: "off", GSC_SYNC: "true", NODE_ENV: "test" });
    expect(await SeoOpportunities.runDue(2, NOW)).toBe(0);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
  });

  it("returns 0 when the allow-list is empty", async () => {
    setEnv({
      SEO_INSIGHTS: "shadow",
      GSC_SYNC: "true",
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user@db.example.neon.tech/main",
    });
    expect(await SeoOpportunities.runDue(2, NOW)).toBe(0);
    expect(mocks.linkFindMany).not.toHaveBeenCalled();
    expect(mocks.beat).not.toHaveBeenCalled();
  });

  it("writes no heartbeat from the dev process and only reads allowed projects", async () => {
    setEnv({
      SEO_INSIGHTS: "shadow",
      GSC_SYNC: "true",
      NODE_ENV: "development",
      DATABASE_URL: "postgres://user@db.example.neon.tech/main",
      GSC_SYNC_DEV_PROJECTS: "p1",
    });
    expect(await SeoOpportunities.runDue(2, NOW)).toBe(1);
    expect(mocks.beat).not.toHaveBeenCalled();
    expect(mocks.ok).not.toHaveBeenCalled();
    expect(mocks.linkFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: { in: ["p1"] } }),
      }),
    );
  });

  it("beats the heartbeat in production and skips inactive projects", async () => {
    mocks.projects.mockResolvedValue([{ id: "p1", status: "PAUSED" }]);
    expect(await SeoOpportunities.runDue(2, NOW)).toBe(0);
    expect(mocks.beat).toHaveBeenCalled();
    expect(mocks.ok).toHaveBeenCalled();
    expect(mocks.linkFindUnique).not.toHaveBeenCalled();
    // Atlanan bağ 6 saat sıradan çıkar: en eski adaylar uygun bağları aç
    // bırakmaz.
    expect(mocks.defer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "link-1", projectId: "p1" }),
      new Date(NOW.getTime() + 21_600_000),
    );
  });
});

describe("SeoOpportunities.runLink", () => {
  it("is busy when the lease is held", async () => {
    mocks.claim.mockResolvedValue(false);
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("busy");
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("runs the weekly stage in order", async () => {
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("ran");
    expect(mocks.order).toEqual([
      "classify",
      "embed",
      "curves",
      "clusters",
      "readClusters",
      "snapshot",
      "rules",
      "persist",
    ]);
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "shadow" }),
    );
    expect(lastRelease()).toMatchObject({
      lastWeek: WEEK,
      lastRunAt: NOW,
      nextRunAt: new Date(NOW.getTime() + 21_600_000),
      consecutiveFailures: 0,
      lastError: null,
      lastRunStats: expect.objectContaining({
        mode: "shadow",
        llmSkipped: null,
      }),
    });
  });

  it("is not due when the week and the mode are unchanged", async () => {
    mocks.ensure.mockResolvedValue(
      state({ lastWeek: WEEK, lastRunStats: { mode: "shadow" } }),
    );
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("not_due");
    expect(mocks.embed).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(lastRelease()).not.toHaveProperty("lastWeek");
  });

  it("forces the weekly stage when the mode changed from shadow to on", async () => {
    setEnv({ SEO_INSIGHTS: "on", GSC_SYNC: "true", NODE_ENV: "test" });
    mocks.ensure.mockResolvedValue(
      state({ lastWeek: WEEK, lastRunStats: { mode: "shadow" } }),
    );
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("ran");
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "on" }),
    );
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({ week: WEEK, periodKey: "W:2026-09-27" }),
    );
  });

  it("returns no_data and keeps lastWeek when the snapshot is missing", async () => {
    mocks.snapshot.mockResolvedValue(null);
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("no_data");
    expect(mocks.evaluate).not.toHaveBeenCalled();
    const data = lastRelease();
    expect(data).not.toHaveProperty("lastWeek");
    expect(data).not.toHaveProperty("lastRunStats");
    expect(data.nextRunAt).toEqual(new Date(NOW.getTime() + 21_600_000));
  });

  it("publishes outputs in mode on on non-weekly runs, never in shadow", async () => {
    setEnv({ SEO_INSIGHTS: "on", GSC_SYNC: "true", NODE_ENV: "test" });
    mocks.ensure.mockResolvedValue(
      state({ lastWeek: WEEK, lastRunStats: { mode: "on" } }),
    );
    mocks.publish.mockResolvedValue({
      explained: 2,
      signals: 1,
      budgetHit: false,
    });
    const on = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(on.status).toBe("ran");
    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot).not.toHaveBeenCalled();

    vi.clearAllMocks();
    setEnv({ SEO_INSIGHTS: "shadow", GSC_SYNC: "true", NODE_ENV: "test" });
    mocks.linkFindUnique.mockResolvedValue(LINK);
    mocks.ensure.mockResolvedValue(
      state({ lastWeek: WEEK, lastRunStats: { mode: "shadow" } }),
    );
    mocks.claim.mockResolvedValue(true);
    mocks.classify.mockResolvedValue({
      classified: 0,
      llmCalls: 0,
      budgetHit: false,
    });
    await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.suggest).not.toHaveBeenCalled();
  });

  it("writes llmSkipped from any budgetHit", async () => {
    mocks.classify.mockResolvedValue({
      classified: 1,
      llmCalls: 1,
      budgetHit: true,
    });
    await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(lastRelease()).toMatchObject({
      lastRunStats: expect.objectContaining({ llmSkipped: "budget" }),
    });

    mocks.classify.mockResolvedValue({
      classified: 0,
      llmCalls: 0,
      budgetHit: false,
    });
    mocks.embed.mockResolvedValue({ embedded: 0, budgetHit: true });
    await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(lastRelease()).toMatchObject({
      lastRunStats: expect.objectContaining({ llmSkipped: "budget" }),
    });
  });

  it("backs off after a failure", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.ensure.mockResolvedValue(state({ consecutiveFailures: 2 }));
    mocks.classify.mockRejectedValue(new Error("database went away"));
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("failed");
    expect(lastRelease()).toMatchObject({
      consecutiveFailures: { increment: 1 },
      lastError: "Error: database went away",
      nextRunAt: new Date(NOW.getTime() + 120 * 60_000),
    });
    expect(engineBackoffMs(1)).toBe(30 * 60_000);
    expect(engineBackoffMs(20)).toBe(24 * 3_600_000);
    error.mockRestore();
  });

  it("refuses a link outside the current mode", async () => {
    mocks.linkFindUnique.mockResolvedValue({ ...LINK, isMock: false });
    const result = await SeoOpportunities.runLink("link-1", { now: NOW });
    expect(result.status).toBe("not_allowed");
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
