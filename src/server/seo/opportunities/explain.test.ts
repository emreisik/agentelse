import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SeoFindingView } from "./findings-store";

// Bu dosyanın kanıtladığı: modele en çok 20 farklı Google dizgisi gider;
// kesirlerin yüzde biçimleri olgulardadır; verinin taşımadığı sayı atılır
// (actualCtr 0.05 iken "5%" kalır); boş açıklama yazılmaz; mock modda hiçbir
// şey saklanmaz ama hafta işaretlenir; bütçe hatası budgetHit döner.

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  readEngineState: vi.fn(),
  updateEngineState: vi.fn(),
  setFindingOutputs: vi.fn(),
  scopeForProject: vi.fn(),
  run: vi.fn(),
  isMockMode: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { seoFinding: { findMany: mocks.findMany } },
}));
vi.mock("./state", () => ({
  readEngineState: mocks.readEngineState,
  updateEngineState: mocks.updateEngineState,
}));
vi.mock("./findings-store", () => ({
  findingViewOf: (row: unknown) => row,
  setFindingOutputs: mocks.setFindingOutputs,
}));
vi.mock("./classify", () => ({ scopeForProject: mocks.scopeForProject }));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: mocks.isMockMode },
}));

import { AgentelseError } from "@/server/security/errors";

import {
  checkedExplanation,
  EXPLAIN_PER_WEEK,
  explainWeek,
  explanationFacts,
} from "./explain";

const LINK = { id: "link-1", projectId: "p1", workspaceId: "ws1" };
const WEEK = "2026-09-21";
const NOW = new Date("2026-10-01T12:00:00Z");

function view(overrides: Partial<SeoFindingView> = {}): SeoFindingView {
  return {
    id: "f1",
    ruleKey: "SO2_CTR_GAP",
    kind: "OPPORTUNITY",
    status: "OPEN",
    severity: "INFO",
    confidence: "SIGNIFICANT",
    effort: "S",
    actionKind: "TITLE_META",
    impact: { kind: "clicks", perMonth: 40, low: 28, high: 52 },
    priority: 40,
    title: "Title",
    summary: "Summary",
    explanation: null,
    evidence: {
      window: { from: "2026-08-31", to: "2026-09-27" },
      metrics: {
        impressions: 1200,
        clicks: 60,
        actualCtr: 0.05,
        expectedCtr: 0.1,
      },
      queries: [
        {
          queryId: "q1",
          text: "running shoes",
          clicks: 60,
          impressions: 1200,
          position: 4.2,
        },
      ],
      pages: [
        {
          pageId: "pg1",
          path: "/blog/shoes",
          url: "https://example.com/blog/shoes",
          clicks: 60,
          impressions: 1200,
          position: 4.2,
        },
      ],
    },
    periodStart: "2026-08-31",
    periodEnd: "2026-09-27",
    periodKey: "W:2026-09-27",
    pageId: "pg1",
    queryId: "q1",
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

function manyStrings(id: string, prefix: string): SeoFindingView {
  const base = view({ id, keyword: `${prefix} keyword` });
  return {
    ...base,
    evidence: {
      ...base.evidence,
      queries: Array.from({ length: 6 }, (_, index) => ({
        queryId: `${id}-q${index}`,
        text: `${prefix} query ${index}`,
        clicks: 1,
        impressions: 10,
        position: 5,
      })),
      pages: Array.from({ length: 4 }, (_, index) => ({
        pageId: null,
        path: `/${prefix}/page-${index}`,
        url: null,
        clicks: 1,
        impressions: 10,
        position: 5,
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readEngineState.mockResolvedValue({ explainedWeek: null });
  mocks.updateEngineState.mockResolvedValue(undefined);
  mocks.setFindingOutputs.mockResolvedValue(undefined);
  mocks.scopeForProject.mockResolvedValue({
    workspaceId: "ws1",
    projectId: "p1",
    brandId: "b1",
  });
  mocks.isMockMode.mockReturnValue(false);
  mocks.findMany.mockResolvedValue([view()]);
});

describe("explanationFacts", () => {
  it("adds percent forms for Ctr and Share fractions", () => {
    const { facts } = explanationFacts([view()]);
    expect(facts[0]?.metrics).toMatchObject({
      actualCtr: 0.05,
      actualCtrPct: 5,
      expectedCtr: 0.1,
      expectedCtrPct: 10,
      impressions: 1200,
    });
    expect(facts[0]?.metrics).not.toHaveProperty("impressionsPct");
    expect(facts[0]).toMatchObject({
      id: "f1",
      action: "TITLE_META",
      confidence: "SIGNIFICANT",
      queries: ["running shoes"],
      pages: ["/blog/shoes"],
    });
  });

  it("keeps at most 20 distinct Google strings in total", () => {
    const findings = ["a", "b", "c"].map((prefix) =>
      manyStrings(`f-${prefix}`, prefix),
    );
    const { facts, strings } = explanationFacts(findings);
    const all = new Set(
      facts.flatMap((fact) => [...fact.queries, ...fact.pages]),
    );
    expect(all.size).toBeLessThanOrEqual(20);
    expect(strings).toBe(all.size);
    // Taşan bulgu sayılarıyla kalır, yeni dizgileri çıkar.
    expect(facts).toHaveLength(3);
    expect(facts[2]?.queries).toEqual([]);
  });
});

describe("checkedExplanation", () => {
  const fact = explanationFacts([view()]).facts[0]!;

  it("keeps a sentence with a supported percent and drops invented numbers", () => {
    expect(
      checkedExplanation(
        {
          explanation:
            "Only 5% of searchers click today. It could reach 37% soon.",
          firstStep: "Rewrite the title for running shoes.",
        },
        fact,
      ),
    ).toBe(
      "Only 5% of searchers click today. Rewrite the title for running shoes.",
    );
  });

  it("returns null when nothing survives", () => {
    expect(
      checkedExplanation(
        { explanation: "It will grow 73%.", firstStep: "" },
        fact,
      ),
    ).toBeNull();
    expect(
      checkedExplanation({ explanation: "", firstStep: "" }, fact),
    ).toBeNull();
  });
});

describe("explainWeek", () => {
  it("asks once for this week's top open findings and stores checked text", async () => {
    mocks.run.mockResolvedValue({
      output: {
        items: [
          {
            id: "f1",
            explanation: "Only 5% click, while 10% is normal here.",
            firstStep: "Rewrite the page title.",
          },
          { id: "unknown", explanation: "Ignored.", firstStep: "Ignored." },
        ],
      },
      isMock: false,
      reasoningCallId: "r1",
    });
    expect(await explainWeek({ link: LINK, week: WEEK, now: NOW })).toEqual({
      explained: 1,
      budgetHit: false,
    });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          linkId: "link-1",
          status: "OPEN",
          shadow: false,
          explanation: null,
          // SO3'ün aylık satırları ("M:") da haftanın güncel dönemindedir.
          OR: [
            { periodKey: "W:2026-09-27" },
            { periodKey: { startsWith: "M:" } },
          ],
        }),
        take: EXPLAIN_PER_WEEK,
      }),
    );
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [def, call] = mocks.run.mock.calls[0]!;
    expect(def).toMatchObject({ purpose: "seo.opportunity-explain" });
    expect(call).toMatchObject({
      workspaceId: "ws1",
      projectId: "p1",
      brandId: "b1",
    });
    expect(mocks.setFindingOutputs).toHaveBeenCalledTimes(1);
    expect(mocks.setFindingOutputs).toHaveBeenCalledWith("f1", {
      explanation:
        "Only 5% click, while 10% is normal here. Rewrite the page title.",
      explainedAt: NOW,
    });
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      explainedWeek: WEEK,
    });
  });

  it("does nothing when the week is already explained", async () => {
    mocks.readEngineState.mockResolvedValueOnce({ explainedWeek: WEEK });
    expect(await explainWeek({ link: LINK, week: WEEK, now: NOW })).toEqual({
      explained: 0,
      budgetHit: false,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("stores nothing in mock mode but still marks the week", async () => {
    mocks.isMockMode.mockReturnValue(true);
    expect(await explainWeek({ link: LINK, week: WEEK, now: NOW })).toEqual({
      explained: 0,
      budgetHit: false,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.setFindingOutputs).not.toHaveBeenCalled();
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      explainedWeek: WEEK,
    });
  });

  it("returns budgetHit on BUDGET_EXCEEDED and leaves the week open", async () => {
    mocks.run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd" },
      }),
    );
    expect(await explainWeek({ link: LINK, week: WEEK, now: NOW })).toEqual({
      explained: 0,
      budgetHit: true,
    });
    expect(mocks.updateEngineState).not.toHaveBeenCalled();
    expect(mocks.setFindingOutputs).not.toHaveBeenCalled();
  });

  it("marks the week when there is nothing to explain", async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await explainWeek({ link: LINK, week: WEEK, now: NOW });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.updateEngineState).toHaveBeenCalledWith("link-1", {
      explainedWeek: WEEK,
    });
  });
});
