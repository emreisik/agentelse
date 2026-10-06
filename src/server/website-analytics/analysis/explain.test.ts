import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: bulgunun verisinde olmayan sayıyı anan cümle
// atılır, desteklenen cümle kalır; bilinmeyen ref yok sayılır; sıralamada
// yalnız bilinen ref'ler (tekrarsız) sıra alır; mock modda ve bayrak
// kapalıyken hiçbir şey yazılmaz; bütçe hatası "budget" döner, başka hata
// "error" (atmaz); bağlam en çok 20 Google dizesi taşır (düşük öncelikli
// bulgu düşer).

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  run: vi.fn(),
  isMockMode: vi.fn(),
  mode: vi.fn(),
  facts: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { gaFinding: { findMany: mocks.findMany, update: mocks.update } },
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run: mocks.run, isMockMode: mocks.isMockMode },
}));
vi.mock("@/lib/website-analytics/analysis/flags", () => ({
  gaInsightsModeFor: mocks.mode,
}));
vi.mock("./read", () => ({
  findingViewOf: (row: GaFindingView) => row,
}));
vi.mock("@/lib/website-analytics/analysis/describe", () => ({
  findingTitle: (f: GaFindingView) => `Finding ${f.id}`,
  findingDetail: (f: GaFindingView) => `Detail of ${f.id}.`,
  findingImpactText: () => null,
  findingPeriodText: () => "Last week",
  findingConfidenceText: () => "Significant",
  findingFacts: (f: GaFindingView) => mocks.facts.get(f.id) ?? {},
}));

const { explainContextOf, explainTopFindings, GA_EXPLAIN_MAX_STRINGS } =
  await import("./explain");

const NOW = new Date("2026-10-06T08:00:00.000Z");
const INPUT = {
  linkId: "link-1",
  projectId: "proj-1",
  workspaceId: "ws-1",
  brandId: "brand-1",
  currency: "EUR",
  now: NOW,
};

function view(id: string, priority: number): GaFindingView {
  return {
    id,
    ruleKey: "AN2",
    kind: "CHANGE",
    subject: "site",
    subjectLabel: "Site",
    period: { grain: "WEEK", from: "2026-09-28", to: "2026-10-04", key: "x" },
    severity: "WARN",
    confidence: "SIGNIFICANT",
    status: "OPEN",
    mode: "live",
    priority,
    impact: null,
    explanation: null,
    occurrences: 1,
    evaluable: false,
    preliminary: false,
    createdAt: NOW.toISOString(),
    acceptedAt: null,
    doneAt: null,
    evaluateAfter: null,
    evaluatedAt: null,
    outcome: null,
    reviewVerdict: null,
  } as unknown as GaFindingView;
}

beforeEach(() => {
  for (const mock of [
    mocks.findMany,
    mocks.update,
    mocks.run,
    mocks.isMockMode,
    mocks.mode,
  ]) {
    mock.mockReset();
  }
  mocks.facts.clear();
  mocks.mode.mockReturnValue("on");
  mocks.isMockMode.mockReturnValue(false);
  mocks.update.mockResolvedValue({});
  mocks.facts.set("a", { sessions: 120, page: "/pricing" });
  mocks.facts.set("b", { keyEvents: 14 });
  mocks.findMany.mockResolvedValue([view("a", 0.9), view("b", 0.5)]);
});

describe("explainTopFindings", () => {
  it("drops an invented number and keeps a supported sentence", async () => {
    mocks.run.mockResolvedValue({
      output: {
        items: [
          {
            ref: "f1",
            explanation:
              "Visits to the pricing page reached 120. That is 37 more than usual.",
          },
          { ref: "f9", explanation: "Unknown finding." },
        ],
        order: [],
      },
    });
    const result = await explainTopFindings(INPUT);
    expect(result).toEqual({ explained: 1, skipped: null });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "a" },
      data: {
        explanation: "Visits to the pricing page reached 120.",
        explainedAt: NOW,
      },
    });
    const where = mocks.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      linkId: "link-1",
      mode: "live",
      isMock: false,
      status: "OPEN",
      explanation: null,
    });
  });

  it("ranks only known refs, once each", async () => {
    mocks.run.mockResolvedValue({
      output: { items: [], order: ["f9", "f2", "f2", "f1", "zz"] },
    });
    await explainTopFindings(INPUT);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "b" },
      data: { rank: 1 },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { rank: 2 },
    });
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("stores nothing in mock mode", async () => {
    mocks.isMockMode.mockReturnValue(true);
    const result = await explainTopFindings(INPUT);
    expect(result).toEqual({ explained: 0, skipped: "mock" });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not query while the mode is not on", async () => {
    mocks.mode.mockReturnValue("shadow");
    const result = await explainTopFindings(INPUT);
    expect(result).toEqual({ explained: 0, skipped: "none" });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns none without a model call when nothing is open", async () => {
    mocks.findMany.mockResolvedValue([]);
    const result = await explainTopFindings(INPUT);
    expect(result).toEqual({ explained: 0, skipped: "none" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("maps a budget error to budget and other errors to error", async () => {
    mocks.run.mockRejectedValueOnce(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "maxReasoningCallsPerDay" },
      }),
    );
    expect(await explainTopFindings(INPUT)).toEqual({
      explained: 0,
      skipped: "budget",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.run.mockRejectedValueOnce(new Error("secret google payload"));
    expect(await explainTopFindings(INPUT)).toEqual({
      explained: 0,
      skipped: "error",
    });
    expect(warn).toHaveBeenCalledWith("[ga-explain] failed");
    warn.mockRestore();
  });
});

describe("explainContextOf", () => {
  it("keeps at most 20 Google strings by dropping low-priority findings", () => {
    const views = [0.9, 0.8, 0.7, 0.6, 0.5].map((priority, index) => {
      const id = `v${index}`;
      mocks.facts.set(id, {
        searches: 40,
        terms: Array.from({ length: 10 }, (_, t) => `term ${index}-${t}`),
      });
      return view(id, priority);
    });
    const { context, refs, googleStrings } = explainContextOf(
      [...views].reverse(),
      null,
    );
    expect(googleStrings).toBeLessThanOrEqual(GA_EXPLAIN_MAX_STRINGS);
    expect(context.findings.map((finding) => finding.ref)).toEqual([
      "f1",
      "f2",
    ]);
    expect(refs.get("f1")).toBe("v0");
    expect(refs.get("f2")).toBe("v1");
  });

  it("counts formatted numbers as numbers, not strings", () => {
    mocks.facts.set("n", { a: "1,234", b: "12.5%", c: "/blog/post" });
    const { googleStrings, context } = explainContextOf([view("n", 1)], null);
    expect(googleStrings).toBe(1);
    expect(context.findings[0]).toMatchObject({
      ref: "f1",
      title: "Finding n",
      confidence: "Significant",
      period: "Last week",
    });
  });
});
