import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsSourceStates } from "@/lib/module-flows/analytics/catalog";
import type { ReportData } from "@/lib/module-flows/analytics/report";
import type { ModuleFlowCardData } from "@/lib/module-flows/card";

// What this suite proves: the Analytics card's actions move the ONE card
// through its steps with the server's own checks. The brief keeps only
// sources that can be read now; a build claims the card (a second one is
// refused), reads the asked sections with the brief's period, writes the
// report with its summary and lands on Review; a build that loses the card
// writes nothing; a failed one goes back; sharing is marked once.

const store = {
  card: null as ModuleFlowCardData | null,
  writes: [] as ModuleFlowCardData[],
};

const mocks = {
  isWorksEnabled: vi.fn(() => true),
  loadAnalyticsSources: vi.fn(),
  collectReport: vi.fn(),
  summarizeReport: vi.fn(),
  commandFindUnique: vi.fn(),
  touch: vi.fn(),
  revalidate: vi.fn(),
};

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: () => false }));
vi.mock("@/server/works/flag", () => ({
  isWorksEnabled: mocks.isWorksEnabled,
}));
vi.mock("@/server/security/tenant-context", () => ({
  requireUser: async () => ({ userId: "u1", email: null }),
  requireProjectAccess: async () => ({
    workspaceId: "w1",
    defaultBrandId: "b1",
  }),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { command: { findUnique: mocks.commandFindUnique } },
}));
vi.mock("@/server/repositories/work.repository", () => ({
  WorkRepository: { touch: mocks.touch },
}));
vi.mock("@/server/modules/analytics/sources", () => ({
  loadAnalyticsSources: mocks.loadAnalyticsSources,
}));
vi.mock("@/server/modules/analytics/collect", () => ({
  collectReport: mocks.collectReport,
}));
vi.mock("@/server/modules/analytics/summary", () => ({
  summarizeReport: mocks.summarizeReport,
}));
// The one card writer, in memory: the same contract (a refusal is its
// message) without the database.
vi.mock("@/server/modules/flow-card", () => ({
  updateModuleFlowCard: async (input: {
    update: (
      card: ModuleFlowCardData,
    ) => ModuleFlowCardData | { reject: string };
  }) => {
    if (!store.card) return { ok: false, message: "Card not found." };
    const next = input.update(store.card);
    if ("reject" in next) return { ok: false, message: next.reject };
    store.card = next;
    store.writes.push(next);
    return { ok: true, card: next };
  },
}));

const actions = await import("./analytics-flow-actions");

const connected: AnalyticsSourceStates = {
  instagram: { status: "connected", account: "@biduniq" },
  metaAds: { status: "connected", account: "Ads" },
  ga4: { status: "not_connected", account: null },
  searchConsole: { status: "setup", account: null },
};

const collected: ReportData = {
  period: 7,
  builtAt: "2026-10-05T12:00:00.000Z",
  sections: [
    {
      source: "instagram",
      ok: true,
      account: "@biduniq",
      days: 7,
      currency: null,
      metrics: [{ key: "ig.reach", value: 1200 }],
      results: [],
      campaigns: [],
      queries: [],
    },
  ],
  summary: null,
  summaryNote: null,
};

const summary = {
  headline: "Reach was 1,200.",
  highlights: [],
  watchouts: [],
  nextSteps: [],
};

function card(
  step: ModuleFlowCardData["step"],
  data: Record<string, unknown> = {},
): ModuleFlowCardData {
  return {
    kind: "module-flow",
    module: "analytics",
    title: "Analytics",
    step,
    data,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  console.error = vi.fn();
  store.card = null;
  store.writes = [];
  mocks.isWorksEnabled.mockReturnValue(true);
  mocks.loadAnalyticsSources.mockResolvedValue(connected);
  mocks.collectReport.mockResolvedValue(collected);
  mocks.summarizeReport.mockResolvedValue({ summary, note: null });
  mocks.commandFindUnique.mockResolvedValue({
    projectId: "p1",
    workId: "work-1",
  });
});

describe("analyticsSourcesAction", () => {
  it("answers the live states, behind the Works gate", async () => {
    expect(await actions.analyticsSourcesAction("p1")).toEqual({
      ok: true,
      sources: connected,
    });
    mocks.isWorksEnabled.mockReturnValue(false);
    expect(await actions.analyticsSourcesAction("p1")).toEqual({
      ok: false,
      message: "Works aren't available.",
    });
  });
});

describe("saveAnalyticsBriefAction", () => {
  it("saves the period and the sources and opens the plan with every section on", async () => {
    store.card = card("brief");
    const result = await actions.saveAnalyticsBriefAction("p1", "c1", {
      period: 7,
      sources: ["metaAds", "instagram"],
    });
    expect(result).toEqual({
      ok: true,
      changed: true,
      message: "Brief saved.",
    });
    expect(store.card).toMatchObject({
      step: "plan",
      data: {
        period: 7,
        sources: ["instagram", "metaAds"],
        sections: ["instagram", "metaAds"],
      },
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/projects/p1");
  });

  it("refuses a source that can't be read right now", async () => {
    store.card = card("brief");
    const result = await actions.saveAnalyticsBriefAction("p1", "c1", {
      period: 28,
      sources: ["instagram", "ga4"],
    });
    expect(result).toMatchObject({ ok: false, code: "SOURCES" });
    expect(store.writes).toHaveLength(0);
  });

  it("refuses a bad brief, and a card another tab already moved", async () => {
    store.card = card("brief");
    expect(
      await actions.saveAnalyticsBriefAction("p1", "c1", {
        period: 30,
        sources: ["instagram"],
      }),
    ).toMatchObject({ ok: false, code: "FAILED" });
    expect(
      await actions.saveAnalyticsBriefAction("p1", "c1", {
        period: 7,
        sources: [],
      }),
    ).toMatchObject({ ok: false, code: "FAILED" });
    store.card = card("plan", { sources: ["instagram"] });
    expect(
      await actions.saveAnalyticsBriefAction("p1", "c1", {
        period: 7,
        sources: ["instagram"],
      }),
    ).toMatchObject({ ok: false, code: "STALE" });
    expect(store.writes).toHaveLength(0);
  });
});

describe("buildAnalyticsReportAction", () => {
  it("claims the card, reads the asked sections and lands on Review with the summary", async () => {
    store.card = card("plan", {
      period: 7,
      sources: ["instagram", "metaAds"],
      sections: ["instagram", "metaAds"],
    });
    mocks.collectReport.mockImplementation(async () => {
      // The card says Create while the sources are read.
      expect(store.card?.step).toBe("create");
      return collected;
    });

    const result = await actions.buildAnalyticsReportAction("p1", "c1", [
      "instagram",
      "searchConsole",
    ]);
    expect(result).toEqual({
      ok: true,
      changed: true,
      message: "Report ready.",
    });
    // Only the brief's sources are read, with the brief's period.
    expect(mocks.collectReport).toHaveBeenCalledWith(
      "p1",
      7,
      ["instagram"],
      expect.any(Number),
    );
    expect(mocks.summarizeReport).toHaveBeenCalledWith(
      { workspaceId: "w1", projectId: "p1", brandId: "b1" },
      collected,
    );
    expect(store.writes.map((written) => written.step)).toEqual([
      "create",
      "review",
    ]);
    expect(store.card).toMatchObject({
      step: "review",
      data: {
        sections: ["instagram"],
        build: null,
        error: null,
        report: { ...collected, summary, summaryNote: null },
      },
    });
    expect(mocks.touch).toHaveBeenCalledWith("p1", "work-1", {
      summary: "Report · Last 7 days",
    });
  });

  it("refuses a second build while one runs", async () => {
    store.card = card("create", {
      sources: ["instagram"],
      build: {
        id: "b1",
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        from: "plan",
      },
    });
    expect(
      await actions.buildAnalyticsReportAction("p1", "c1", ["instagram"]),
    ).toEqual({
      ok: false,
      code: "FAILED",
      message: "This report is already being built.",
    });
    expect(mocks.collectReport).not.toHaveBeenCalled();
  });

  it("writes nothing when another build took the card meanwhile", async () => {
    store.card = card("review", {
      sources: ["instagram"],
      sections: ["instagram"],
    });
    mocks.collectReport.mockImplementation(async () => {
      const data = store.card!.data as { build: { id: string } };
      store.card = {
        ...store.card!,
        data: { ...data, build: { ...data.build, id: "someone-else" } },
      };
      return collected;
    });
    expect(
      await actions.buildAnalyticsReportAction("p1", "c1", ["instagram"]),
    ).toMatchObject({ ok: false, code: "STALE" });
    expect(store.card?.step).toBe("create");
    expect(mocks.touch).not.toHaveBeenCalled();
  });

  it("goes back where it came from when the build fails", async () => {
    store.card = card("deliver", {
      sources: ["instagram"],
      sections: ["instagram"],
      report: collected,
    });
    mocks.collectReport.mockRejectedValue(new Error("down"));
    expect(
      await actions.buildAnalyticsReportAction("p1", "c1", ["instagram"]),
    ).toEqual({
      ok: false,
      code: "FAILED",
      message: "Building the report failed. Try again.",
    });
    expect(store.card).toMatchObject({
      step: "deliver",
      data: {
        build: null,
        error: "Building the report failed. Try again.",
        report: collected,
      },
    });
  });
});

describe("openAnalyticsStepAction and markAnalyticsSharedAction", () => {
  it("opens Share from a report, never a step without one", async () => {
    store.card = card("review", { sources: ["instagram"], report: collected });
    expect(
      await actions.openAnalyticsStepAction("p1", "c1", "deliver"),
    ).toEqual({ ok: true, changed: true });
    expect(store.card?.step).toBe("deliver");

    store.card = card("plan", { sources: ["instagram"] });
    expect(
      await actions.openAnalyticsStepAction("p1", "c1", "review"),
    ).toMatchObject({ ok: false, code: "STALE" });
    expect(
      await actions.openAnalyticsStepAction("p1", "c1", "create"),
    ).toMatchObject({ ok: false, code: "FAILED" });
  });

  it("marks the first share only", async () => {
    store.card = card("deliver", { sources: ["instagram"], report: collected });
    expect(await actions.markAnalyticsSharedAction("p1", "c1")).toEqual({
      ok: true,
      changed: true,
    });
    const sharedAt = (store.card?.data as { sharedAt?: unknown }).sharedAt;
    expect(typeof sharedAt).toBe("string");
    expect(await actions.markAnalyticsSharedAction("p1", "c1")).toEqual({
      ok: true,
      changed: false,
    });
    expect(store.writes).toHaveLength(1);
  });
});
