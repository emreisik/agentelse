import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoFindingView } from "@/server/seo/opportunities/findings-store";

// Bu dosyanın kanıtladığı (SC-F4 Opportunities verisi): SEO_INSIGHTS,
// GSC_SEARCH_PAGE ya da izin listesi kapalıyken hiçbir sorgu yok; gölge kipte
// operatör olmayan kullanıcı null alır, operatör yalnız gölge incelemeyi;
// "on" kipte açık ve kabul edilmiş liste; eskimiş (SUPERSEDED) vurgu güncel
// satıra gider; collecting / low_data notları ve etki etiketleri.
// Kardeş paketlerin modülleri taklit edilir.

const mocks = vi.hoisted(() => ({
  mode: vi.fn(),
  active: vi.fn(),
  searchPage: vi.fn(),
  allowed: vi.fn(),
  operator: vi.fn(),
  primaryGscLink: vi.fn(),
  readEngineState: vi.fn(),
  listProjectFindings: vi.fn(),
  resolveFindingHighlight: vi.fn(),
  count: vi.fn(),
}));

vi.mock("@/lib/seo/insight-flags", () => ({
  SeoInsightFlags: {
    mode: mocks.mode,
    active: mocks.active,
    userFacing: () => mocks.mode() === "on",
  },
  seoInsightsAllowedFor: mocks.allowed,
}));
vi.mock("@/lib/seo/flags", () => ({
  GscFlags: { searchPage: mocks.searchPage, sync: () => true },
}));
vi.mock("@/server/security/operator", () => ({
  isPlatformOperator: mocks.operator,
}));
vi.mock("@/server/seo/store", () => ({
  primaryGscLink: mocks.primaryGscLink,
}));
vi.mock("@/server/seo/opportunities/state", () => ({
  readEngineState: mocks.readEngineState,
}));
vi.mock("@/server/seo/opportunities/findings-store", () => ({
  listProjectFindings: mocks.listProjectFindings,
  resolveFindingHighlight: mocks.resolveFindingHighlight,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { seoFinding: { count: mocks.count } },
}));

const {
  loadOpportunitiesPanel,
  impactLabel,
  ACTION_LABEL,
  EFFORT_LABEL,
  COLLECTING_NOTE,
  LOW_DATA_NOTE,
} = await import("./panel");

const NOW = new Date("2026-10-07T10:00:00.000Z");

function view(overrides: Partial<SeoFindingView> = {}): SeoFindingView {
  return {
    id: "f-1",
    ruleKey: "SO1_STRIKING_DISTANCE",
    kind: "OPPORTUNITY",
    status: "OPEN",
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "S",
    actionKind: "TITLE_META",
    impact: { kind: "clicks", perMonth: 120, low: 84, high: 156 },
    priority: 120,
    title: "Push “running shoes” onto page one",
    summary: "It ranks 8.4 with 3,400 impressions.",
    explanation: null,
    evidence: {
      window: { from: "2026-08-31", to: "2026-09-27" },
      metrics: { impressions: 3400 },
    },
    periodStart: "2026-08-31",
    periodEnd: "2026-09-27",
    periodKey: "W:2026-09-27",
    pageId: "page-1",
    queryId: "q-1",
    clusterId: null,
    keyword: "running shoes",
    ideaIds: [],
    signalId: null,
    shadow: false,
    review: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

const STATE = {
  id: "state-1",
  lastWeek: "2026-09-21",
  lastRunAt: new Date("2026-10-06T08:00:00.000Z"),
  lastRunStats: { mode: "on", lowData: false },
};

function expectNoReads() {
  expect(mocks.primaryGscLink).not.toHaveBeenCalled();
  expect(mocks.readEngineState).not.toHaveBeenCalled();
  expect(mocks.listProjectFindings).not.toHaveBeenCalled();
  expect(mocks.count).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.mode.mockReturnValue("on");
  mocks.active.mockReturnValue(true);
  mocks.searchPage.mockReturnValue(true);
  mocks.allowed.mockReturnValue(true);
  mocks.operator.mockReturnValue(false);
  mocks.primaryGscLink.mockResolvedValue({ id: "link-1", projectId: "p1" });
  mocks.readEngineState.mockResolvedValue(STATE);
  mocks.listProjectFindings.mockResolvedValue([]);
  mocks.resolveFindingHighlight.mockResolvedValue(null);
  mocks.count.mockResolvedValue(0);
});

describe("loadOpportunitiesPanel gates", () => {
  it("reads nothing when SEO_INSIGHTS is off", async () => {
    mocks.mode.mockReturnValue("off");
    mocks.active.mockReturnValue(false);
    await expect(
      loadOpportunitiesPanel("p1", { userId: "u1", now: NOW }),
    ).resolves.toBeNull();
    expectNoReads();
  });

  it("reads nothing when the Search page is off", async () => {
    mocks.searchPage.mockReturnValue(false);
    await expect(
      loadOpportunitiesPanel("p1", { userId: "u1", now: NOW }),
    ).resolves.toBeNull();
    expectNoReads();
  });

  it("reads nothing for a project outside the rollout", async () => {
    mocks.allowed.mockReturnValue(false);
    await expect(
      loadOpportunitiesPanel("p1", { userId: "u1", now: NOW }),
    ).resolves.toBeNull();
    expect(mocks.allowed).toHaveBeenCalledWith("p1");
    expectNoReads();
  });

  it("shows nothing to a non-operator in shadow mode", async () => {
    mocks.mode.mockReturnValue("shadow");
    await expect(
      loadOpportunitiesPanel("p1", { userId: "u1", now: NOW }),
    ).resolves.toBeNull();
    expect(mocks.operator).toHaveBeenCalledWith("u1");
    expectNoReads();
  });
});

describe("loadOpportunitiesPanel modes", () => {
  it("gives an operator only the shadow review in shadow mode", async () => {
    mocks.mode.mockReturnValue("shadow");
    mocks.operator.mockReturnValue(true);
    mocks.listProjectFindings.mockResolvedValue([
      view({ shadow: true, review: "USEFUL" }),
    ]);
    mocks.count.mockResolvedValue(1);
    const panel = await loadOpportunitiesPanel("p1", {
      userId: "op",
      now: NOW,
    });
    expect(panel?.mode).toBe("shadow");
    expect(panel?.items).toEqual([]);
    expect(panel?.accepted).toEqual([]);
    expect(panel?.shadowReview).toHaveLength(1);
    expect(panel?.shadowReview?.[0]?.review).toBe("USEFUL");
    expect(panel?.counts.open).toBe(1);
    expect(mocks.listProjectFindings).toHaveBeenCalledTimes(1);
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      statuses: ["OPEN"],
      shadow: true,
      limit: 30,
    });
  });

  it("lists open and accepted opportunities in mode on", async () => {
    mocks.listProjectFindings.mockImplementation(
      async (_projectId: string, options: { statuses: string[] }) =>
        options.statuses[0] === "OPEN"
          ? [view(), view({ id: "f-2", confidence: "DIRECTIONAL" })]
          : [view({ id: "f-3", status: "ACCEPTED" })],
    );
    mocks.count
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const panel = await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
    });
    expect(panel).toMatchObject({
      projectId: "p1",
      mode: "on",
      state: "ready",
      week: "2026-09-21",
      shadowReview: null,
      counts: { open: 7, accepted: 1, done30d: 2 },
      notes: [],
    });
    expect(panel?.items.map((item) => item.id)).toEqual(["f-1", "f-2"]);
    expect(panel?.accepted.map((item) => item.id)).toEqual(["f-3"]);
    expect(panel?.items[0]).toMatchObject({
      actionLabel: "Fix the snippet",
      effortLabel: "Quick fix",
      confidenceLabel: "Solid",
      impactLabel: "Expected +120 clicks/month",
      highlighted: false,
    });
    expect(panel?.items[1]?.confidenceLabel).toBe("Directional");
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      statuses: ["OPEN"],
      shadow: false,
      limit: 20,
    });
    expect(mocks.listProjectFindings).toHaveBeenCalledWith("p1", {
      statuses: ["ACCEPTED"],
      shadow: false,
      limit: 10,
    });
    // Son 30 günde biten satırlar.
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        linkId: "link-1",
        status: "DONE",
        shadow: false,
        decidedAt: { gte: new Date("2026-09-07T10:00:00.000Z") },
      },
    });
  });

  it("follows a superseded highlight id to the current row", async () => {
    mocks.listProjectFindings.mockImplementation(
      async (_projectId: string, options: { statuses: string[] }) =>
        options.statuses[0] === "OPEN"
          ? [view({ id: "current" }), view({ id: "other" })]
          : [],
    );
    mocks.resolveFindingHighlight.mockResolvedValue("current");
    const panel = await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
      highlight: "old-week",
    });
    expect(mocks.resolveFindingHighlight).toHaveBeenCalledWith(
      "p1",
      "old-week",
    );
    expect(panel?.items.map((item) => [item.id, item.highlighted])).toEqual([
      ["current", true],
      ["other", false],
    ]);
  });

  it("ignores a malformed highlight without a lookup", async () => {
    await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
      highlight: "x'; drop",
    });
    expect(mocks.resolveFindingHighlight).not.toHaveBeenCalled();
  });

  it("says it is collecting when the engine has not finished a week", async () => {
    mocks.readEngineState.mockResolvedValue(null);
    const panel = await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
    });
    expect(panel?.state).toBe("collecting");
    expect(panel?.notes).toEqual([COLLECTING_NOTE]);
    expect(panel?.items).toEqual([]);
    expect(mocks.listProjectFindings).not.toHaveBeenCalled();

    mocks.readEngineState.mockResolvedValue({ ...STATE, lastWeek: null });
    const empty = await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
    });
    expect(empty?.state).toBe("collecting");
  });

  it("says content and indexing come first on a low-data site", async () => {
    mocks.readEngineState.mockResolvedValue({
      ...STATE,
      lastRunStats: { mode: "on", lowData: true },
    });
    const panel = await loadOpportunitiesPanel("p1", {
      userId: "u1",
      now: NOW,
    });
    expect(panel?.state).toBe("low_data");
    expect(panel?.notes).toEqual([LOW_DATA_NOTE]);
    expect(LOW_DATA_NOTE).toBe(
      "Your site gets fewer than 1,000 search impressions a month, so opportunities focus on content and indexing first.",
    );
  });

  it("returns null without a Search Console link", async () => {
    mocks.primaryGscLink.mockResolvedValue(null);
    await expect(
      loadOpportunitiesPanel("p1", { userId: "u1", now: NOW }),
    ).resolves.toBeNull();
    expect(mocks.readEngineState).not.toHaveBeenCalled();
  });
});

describe("labels", () => {
  it("formats click and reach impact", () => {
    expect(
      impactLabel(
        { kind: "clicks", perMonth: 120, low: 84, high: 156 },
        "SIGNIFICANT",
      ),
    ).toBe("Expected +120 clicks/month");
    expect(
      impactLabel(
        { kind: "clicks", perMonth: 1250, low: 625, high: 1875 },
        "DIRECTIONAL",
      ),
    ).toBe("Expected +1,250 clicks/month (directional)");
    expect(
      impactLabel({ kind: "reach", impressionsPerMonth: 3400 }, "DIRECTIONAL"),
    ).toBe("Affects pages with 3,400 impressions a month");
    expect(impactLabel(null, "SIGNIFICANT")).toBeNull();
    expect(
      impactLabel(
        { kind: "clicks", perMonth: 0, low: 0, high: 0 },
        "SIGNIFICANT",
      ),
    ).toBeNull();
  });

  it("names every action and effort", () => {
    expect(ACTION_LABEL).toEqual({
      TITLE_META: "Fix the snippet",
      CONTENT_REFRESH: "Refresh the page",
      NEW_CONTENT: "Write a new page",
      INTERNAL_LINKS: "Add internal links",
      CONSOLIDATE: "Merge or separate pages",
      TECH_FIX: "Fix the technical issue",
      SCHEMA: "Add structured data",
      LOCALIZE: "Add a localized version",
      INVESTIGATE: "Look into it",
    });
    expect(EFFORT_LABEL).toEqual({
      S: "Quick fix",
      M: "Some work",
      L: "Bigger project",
      VARIES: "Varies",
    });
  });
});
