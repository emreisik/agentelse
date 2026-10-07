import type { GscSiteLink } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  planDataFixture,
  planInputFixture,
  slotFixture,
} from "@/lib/seo/content-plan/test-support";

// Bu dosyanın kanıtladığı (W3 bağdaştırıcısı): motor haftası geride kalırsa
// ENGINE_BEHIND, anlık görüntü yoksa NO_DATA; bulgular açık/kabul ve reddedilen
// diye ayrı okunur; reddedilen anahtarlar son 3 planın data.rejected'ından gelir;
// önceki slot anahtar kelimeleri yalnız Creative'i arşivlenmemişse sayılır;
// havuz fikirleri yalnız aynı kipin (isMock) ve süresi dolmamış olanlardır;
// planlanmış fikirler mevcut anahtar kelimedir, havuzdakiler değildir.

const mocks = vi.hoisted(() => ({
  readEngineState: vi.fn(),
  readClusters: vi.fn(),
  loadRuleSnapshot: vi.fn(),
  listProjectFindings: vi.fn(),
  scopeForProject: vi.fn(),
  readIdeaRows: vi.fn(),
  postFindMany: vi.fn(),
  planFindMany: vi.fn(),
  creativeFindMany: vi.fn(),
  planInputFromSnapshot: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    post: { findMany: mocks.postFindMany },
    seoContentPlan: { findMany: mocks.planFindMany },
    creative: { findMany: mocks.creativeFindMany },
  },
}));
vi.mock("@/server/seo/opportunities/state", () => ({
  readEngineState: mocks.readEngineState,
  parseSeoCurves: () => ({ nonBrand: {}, brand: {} }),
}));
vi.mock("@/server/seo/opportunities/clusters", () => ({
  readClusters: mocks.readClusters,
}));
vi.mock("@/server/seo/opportunities/snapshot", () => ({
  loadRuleSnapshot: mocks.loadRuleSnapshot,
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  listProjectFindings: mocks.listProjectFindings,
}));
vi.mock("@/server/seo/opportunities/classify", () => ({
  scopeForProject: mocks.scopeForProject,
}));
vi.mock("@/server/ideas/idea-context", () => ({
  readIdeaRows: mocks.readIdeaRows,
}));
vi.mock("@/lib/seo/content-plan/candidates", () => ({
  planInputFromSnapshot: mocks.planInputFromSnapshot,
}));

const { loadPlanInput, monthsBack } = await import("./inputs");

const NOW = new Date("2026-10-07T09:00:00Z");
const WEEK = "2026-09-28";

function link(overrides: Partial<GscSiteLink> = {}): GscSiteLink {
  return {
    id: "link-1",
    projectId: "p1",
    workspaceId: "w1",
    isMock: false,
    lastWeeklyWeek: WEEK,
    ...overrides,
  } as GscSiteLink;
}

function seoIdea(
  id: string,
  status: string,
  keyword: string,
  overrides: { isMock?: boolean; expiresAt?: string } = {},
) {
  return {
    id,
    status,
    title: `Title ${keyword}`,
    description: "d",
    createdAt: NOW,
    updatedAt: NOW,
    isMock: overrides.isMock ?? false,
    concept: {
      v: 2,
      module: "seo",
      source: "search",
      ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
      draft: {
        keyword,
        intent: "informational",
        title: `Title ${keyword}`,
        description: "desc",
        angle: "angle",
      },
    },
  };
}

function finding(
  id: string,
  ruleKey: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    ruleKey,
    status,
    queryId: "q1",
    clusterId: null,
    confidence: "SIGNIFICANT",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readEngineState.mockResolvedValue({
    lastWeek: WEEK,
    clustersWeek: WEEK,
    curves: null,
  });
  mocks.scopeForProject.mockResolvedValue({
    workspaceId: "w1",
    projectId: "p1",
    brandId: "b1",
  });
  mocks.readClusters.mockResolvedValue([]);
  mocks.loadRuleSnapshot.mockResolvedValue({
    projectLanguage: "tr",
    crawl: {
      complete: true,
      pages: [{ title: "Crawl title", h1: ["Crawl h1"] }],
      links: [],
    },
  });
  mocks.listProjectFindings.mockResolvedValue([]);
  mocks.readIdeaRows.mockResolvedValue([]);
  mocks.postFindMany.mockResolvedValue([]);
  mocks.planFindMany.mockResolvedValue([]);
  mocks.creativeFindMany.mockResolvedValue([]);
  mocks.planInputFromSnapshot.mockImplementation(
    (_snapshot: unknown, extras: Record<string, unknown>) => ({
      ...planInputFixture(),
      ...extras,
    }),
  );
});

const args = { month: "2026-10", timezone: "Europe/Istanbul", now: NOW };

describe("monthsBack", () => {
  it("steps back across a year boundary", () => {
    expect(monthsBack("2026-10", 3)).toBe("2026-07");
    expect(monthsBack("2026-02", 3)).toBe("2025-11");
    expect(monthsBack("2026-01", 1)).toBe("2025-12");
  });
});

describe("loadPlanInput gates", () => {
  it("reports NO_DATA without a weekly week and reads nothing", async () => {
    const result = await loadPlanInput({ link: link({ lastWeeklyWeek: null }), ...args });
    expect(result).toEqual({ ok: false, empty: "NO_DATA" });
    expect(mocks.readEngineState).not.toHaveBeenCalled();
  });

  it("asks to retry when the engine's clusters lag behind the week", async () => {
    mocks.readEngineState.mockResolvedValue({ lastWeek: WEEK, clustersWeek: "2026-09-21" });
    expect(await loadPlanInput({ link: link(), ...args })).toEqual({
      ok: false,
      retry: "ENGINE_BEHIND",
    });
    expect(mocks.loadRuleSnapshot).not.toHaveBeenCalled();
  });

  it("asks to retry when the engine has no state or an older week", async () => {
    mocks.readEngineState.mockResolvedValue(null);
    expect(await loadPlanInput({ link: link(), ...args })).toEqual({
      ok: false,
      retry: "ENGINE_BEHIND",
    });
    mocks.readEngineState.mockResolvedValue({ lastWeek: "2026-09-21", clustersWeek: WEEK });
    expect(await loadPlanInput({ link: link(), ...args })).toEqual({
      ok: false,
      retry: "ENGINE_BEHIND",
    });
  });

  it("reports NO_DATA for a missing snapshot", async () => {
    mocks.loadRuleSnapshot.mockResolvedValue(null);
    expect(await loadPlanInput({ link: link(), ...args })).toEqual({
      ok: false,
      empty: "NO_DATA",
    });
  });
});

describe("loadPlanInput extras", () => {
  it("splits findings into live and dismissed reads and keeps only SO5/SO6", async () => {
    mocks.listProjectFindings.mockImplementation(
      async (_project: string, options: { statuses: string[] }) =>
        options.statuses.includes("DISMISSED")
          ? [finding("f3", "SO5_CONTENT_GAP", "DISMISSED")]
          : [
              finding("f1", "SO5_CONTENT_GAP", "OPEN"),
              finding("f2", "SO6_RISING_QUERY", "ACCEPTED", { confidence: "DIRECTIONAL" }),
              finding("f9", "SO1_OTHER", "OPEN"),
            ],
    );
    await loadPlanInput({ link: link(), ...args });
    expect(mocks.listProjectFindings).toHaveBeenCalledTimes(2);
    const extras = mocks.planInputFromSnapshot.mock.calls[0]![1];
    expect(extras.findings.map((f: { id: string }) => f.id)).toEqual(["f1", "f2", "f3"]);
    expect(extras.findings[2]).toMatchObject({ status: "DISMISSED" });
  });

  it("collects rejected keys from the previous plans and queries the 3-month window", async () => {
    mocks.planFindMany.mockResolvedValue([
      { month: "2026-08", data: { ...planDataFixture({ slots: [], rejected: ["key one"] }) } },
      { month: "2026-09", data: { ...planDataFixture({ slots: [], rejected: ["key two", "key one"] }) } },
    ]);
    await loadPlanInput({ link: link(), ...args });
    expect(mocks.planFindMany.mock.calls[0]![0].where).toMatchObject({
      linkId: "link-1",
      month: { gte: "2026-07", lte: "2026-10" },
    });
    const extras = mocks.planInputFromSnapshot.mock.calls[0]![1];
    expect([...extras.rejectedKeys].sort()).toEqual(["key one", "key two"]);
    expect(extras.deprioritizedKeys).toEqual([]);
  });

  it("counts earlier slot keywords only while their creative is not archived", async () => {
    mocks.planFindMany.mockResolvedValue([
      {
        month: "2026-09",
        data: planDataFixture({
          slots: [
            slotFixture({ id: "s1", keyword: "live keyword", creativeId: "c-live" }),
            slotFixture({ id: "s2", keyword: "archived keyword", creativeId: "c-archived" }),
          ],
        }),
      },
    ]);
    // Arşivlenmemiş creative'ler sorgusu yalnız c-live'ı döndürür.
    mocks.creativeFindMany.mockImplementation(
      async (args: { where: { id?: { in: string[] }; status?: unknown } }) =>
        args.where.id ? [{ id: "c-live" }] : [],
    );
    await loadPlanInput({ link: link(), ...args });
    const live = mocks.creativeFindMany.mock.calls.find((call) => call[0].where.id)![0];
    expect(live.where.status).toEqual({ not: "ARCHIVED" });
    const extras = mocks.planInputFromSnapshot.mock.calls[0]![1];
    expect(extras.existingKeywords).toEqual(["live keyword"]);
  });

  it("uses only same-mode, unexpired pool ideas; planned ideas are existing keywords", async () => {
    mocks.readIdeaRows.mockResolvedValue([
      seoIdea("i1", "VALIDATED", "pool keyword"),
      seoIdea("i2", "VALIDATED", "mock keyword", { isMock: true }),
      seoIdea("i3", "RAW", "expired keyword", { expiresAt: "2026-01-01T00:00:00Z" }),
      seoIdea("i4", "PLANNING", "planned keyword"),
      seoIdea("i5", "ARCHIVED", "archived keyword"),
      {
        id: "i6",
        status: "VALIDATED",
        title: "social",
        description: "x",
        createdAt: NOW,
        updatedAt: NOW,
        isMock: false,
        concept: { v: 2, module: "social", source: "brand", draft: {} },
      },
    ]);
    await loadPlanInput({ link: link(), ...args });
    const extras = mocks.planInputFromSnapshot.mock.calls[0]![1];
    expect(extras.poolIdeas.map((idea: { id: string }) => idea.id)).toEqual(["i1"]);
    expect(extras.poolIdeas[0]).toMatchObject({
      keyword: "pool keyword",
      intent: "informational",
    });
    expect(extras.existingKeywords).toEqual(["planned keyword"]);
  });

  it("limits the pool to 50 ideas", async () => {
    mocks.readIdeaRows.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => seoIdea(`i${i}`, "VALIDATED", `kw ${i}`)),
    );
    await loadPlanInput({ link: link(), ...args });
    expect(mocks.planInputFromSnapshot.mock.calls[0]![1].poolIdeas).toHaveLength(50);
  });

  it("builds existing titles from seo posts and crawl titles", async () => {
    mocks.postFindMany.mockResolvedValue([{ topic: "Written article" }, { topic: "Crawl title" }]);
    await loadPlanInput({ link: link(), ...args });
    const where = mocks.postFindMany.mock.calls[0]![0];
    expect(where.take).toBe(60);
    expect(where.where.deliveries.some.formatKey).toBe("seo.article");
    const extras = mocks.planInputFromSnapshot.mock.calls[0]![1];
    expect(extras.existingTitles).toEqual(["Written article", "Crawl title", "Crawl h1"]);
  });

  it("returns the project's language, scope and the month's counted pieces", async () => {
    mocks.creativeFindMany.mockImplementation(
      async (args: { where: { id?: unknown } }) =>
        args.where.id
          ? []
          : [
              { id: "m1", scheduledFor: new Date("2026-10-14T07:00:00Z") },
              { id: "m2", scheduledFor: new Date("2026-10-14T08:00:00Z") },
              { id: "m3", scheduledFor: new Date("2026-10-21T07:00:00Z") },
            ],
    );
    const result = await loadPlanInput({ link: link(), ...args });
    expect(result).toMatchObject({
      ok: true,
      language: "tr",
      existingInMonth: 3,
      takenDates: ["2026-10-14", "2026-10-21"],
      scope: { workspaceId: "w1", projectId: "p1", brandId: "b1" },
    });
  });

  it("does not count ignored pieces and ignores their ideas and titles", async () => {
    mocks.readIdeaRows.mockResolvedValue([seoIdea("own", "PLANNING", "own keyword")]);
    mocks.creativeFindMany.mockImplementation(
      async (args: { where: { id?: unknown } }) =>
        args.where.id
          ? []
          : [
              { id: "mine", scheduledFor: new Date("2026-10-14T07:00:00Z") },
              { id: "other", scheduledFor: new Date("2026-10-20T07:00:00Z") },
            ],
    );
    const result = await loadPlanInput({
      link: link(),
      ...args,
      ignore: { ideaIds: ["own"], creativeIds: ["mine"] },
    });
    expect(result).toMatchObject({ ok: true, existingInMonth: 1, takenDates: ["2026-10-20"] });
    expect(mocks.planInputFromSnapshot.mock.calls[0]![1].existingKeywords).toEqual([]);
    expect(mocks.postFindMany.mock.calls[0]![0].where.deliveries.some.id).toEqual({
      notIn: ["mine"],
    });
  });
});
