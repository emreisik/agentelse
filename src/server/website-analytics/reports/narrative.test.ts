import { beforeEach, describe, expect, it, vi } from "vitest";

import { WEBSITE_REPORT_COPY as COPY } from "@/lib/website-analytics/reports/copy";
import { reportFactsOf } from "@/lib/website-analytics/reports/facts";
import {
  sampleAlertCard,
  sampleWeeklyCard,
} from "@/lib/website-analytics/reports/test-fixtures";
import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: mock modda ve demo bağda model çağrılmaz ve sahte
// anlatı saklanmaz; uydurma rakamlı cümle atılır (hiçbiri kalmazsa
// "dropped"); BUDGET hatası sınır metnine döner; beklenmeyen hata "error"
// olur ve loga hata MESAJI girmez (model çıktısı Google metni taşıyabilir);
// modele giden olgular en çok 20 Google metni taşır; haftalık/aylık dışı
// kart için çağrı yok; ortak narrateCard adımı kipe göre atlar ya da yazar.

const reasoning = vi.hoisted(() => ({
  isMockMode: vi.fn<() => boolean>(),
  run: vi.fn(),
}));

vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: reasoning,
}));

const { narrateCard, writeReportNarrative } = await import("./narrative");

const SCOPE = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

function summary(partial: Partial<Record<string, unknown>> = {}) {
  return {
    output: {
      headline: "Traffic held steady.",
      highlights: [],
      watchouts: [],
      nextSteps: [],
      ...partial,
    },
    isMock: false,
    reasoningCallId: "call-1",
  };
}

function firstKpiValue(): string {
  const built = reportFactsOf(sampleWeeklyCard(), []);
  const kpi = built?.facts.kpis[0];
  if (!kpi) throw new Error("fixture has no KPI");
  return kpi.value;
}

beforeEach(() => {
  reasoning.isMockMode.mockReset().mockReturnValue(false);
  reasoning.run.mockReset();
  vi.restoreAllMocks();
});

describe("writeReportNarrative", () => {
  it("skips the model in reasoning mock mode", async () => {
    reasoning.isMockMode.mockReturnValue(true);
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome).toEqual({
      narrative: null,
      note: COPY.narrativeMock,
      status: "mock",
    });
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("skips the model for demo data", async () => {
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: true }),
      findings: [],
    });
    expect(outcome).toEqual({
      narrative: null,
      note: COPY.narrativeDemo,
      status: "demo",
    });
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("does nothing for a card that has no narrative", async () => {
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleAlertCard(),
      findings: [],
    });
    expect(outcome).toEqual({ narrative: null, note: null, status: "none" });
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("stores a summary whose numbers are all in the data", async () => {
    const value = firstKpiValue();
    reasoning.run.mockResolvedValue(
      summary({ headline: `Sessions were ${value} last week.` }),
    );
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.note).toBeNull();
    expect(outcome.narrative?.headline).toContain(value);
  });

  it("drops a sentence with a fabricated number and keeps the rest", async () => {
    reasoning.run.mockResolvedValue(
      summary({
        headline: "Sessions grew by 987,654,321 percent.",
        highlights: ["The top channel stayed the same."],
      }),
    );
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.narrative?.headline).toBe("");
    expect(outcome.narrative?.highlights).toEqual([
      "The top channel stayed the same.",
    ]);
  });

  it("keeps a sentence that states a decline as an unsigned number", async () => {
    // Olgular işaretli değişim (-37.3) taşır; model "fell 37.3%" yazar.
    const base = sampleWeeklyCard({ isMock: false });
    if (base.body.variant !== "weekly") throw new Error("fixture is not weekly");
    const card = {
      ...base,
      body: {
        ...base.body,
        kpis: base.body.kpis.map((row) =>
          row.key === "sessions"
            ? { ...row, value: 2700, previous: 4300, changePct: -37.3 }
            : row,
        ),
      },
    };
    reasoning.run.mockResolvedValue(
      summary({ watchouts: ["Sessions fell 37.3% to 2,700."] }),
    );
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card,
      findings: [],
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.narrative?.watchouts).toEqual([
      "Sessions fell 37.3% to 2,700.",
    ]);
  });

  it("reports dropped when nothing supported is left", async () => {
    reasoning.run.mockResolvedValue(
      summary({ headline: "Sessions grew by 987,654,321 percent." }),
    );
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome).toEqual({
      narrative: null,
      note: COPY.narrativeDropped,
      status: "dropped",
    });
  });

  it("turns a budget error into the limit text", async () => {
    reasoning.run.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "cap", {
        meta: { limit: "dailyBudgetUsd", cap: 1, used: 1 },
      }),
    );
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome.status).toBe("budget");
    expect(outcome.narrative).toBeNull();
    expect(outcome.note).toContain("AI budget");
  });

  it("never logs the error message and never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = "/pricing?email=owner@example.com leaked";
    reasoning.run.mockRejectedValue(new TypeError(secret));
    const outcome = await writeReportNarrative({
      scope: SCOPE,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
    });
    expect(outcome).toEqual({
      narrative: null,
      note: COPY.narrativeFailed,
      status: "error",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("owner@example.com");
  });

  it("gives the model at most 20 Google strings", async () => {
    reasoning.run.mockResolvedValue(summary());
    const card = sampleWeeklyCard({ isMock: false });
    await writeReportNarrative({ scope: SCOPE, card, findings: [] });
    expect(reasoning.run).toHaveBeenCalledTimes(1);
    const call = reasoning.run.mock.calls[0];
    const context = call?.[1] as {
      context: { facts: unknown };
      brandId: string;
    };
    expect(context.brandId).toBe("brand-1");
    expect(context.context.facts).toBeTruthy();
    const built = reportFactsOf(card, []);
    expect(built?.googleStrings ?? 99).toBeLessThanOrEqual(20);
  });
});

describe("narrateCard", () => {
  const ctx = {
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
  } as Parameters<typeof narrateCard>[0]["ctx"];

  it("writes without a model call in skip mode and says why", async () => {
    const { card, status } = await narrateCard({
      ctx,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
      mode: "skip",
    });
    expect(status).toBe("skipped");
    expect(card.narrative).toBeNull();
    expect(card.narrativeNote).toBe(COPY.narrativeFailed);
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("skips when the project has no brand", async () => {
    const { status } = await narrateCard({
      ctx: { ...ctx, brandId: null },
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
      mode: "allow",
    });
    expect(status).toBe("skipped");
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("names the demo reason even in skip mode", async () => {
    const { card, status } = await narrateCard({
      ctx,
      card: sampleWeeklyCard({ isMock: true }),
      findings: [],
      mode: "skip",
    });
    expect(status).toBe("demo");
    expect(card.narrativeNote).toBe(COPY.narrativeDemo);
  });

  it("calls the model in allow mode", async () => {
    reasoning.run.mockResolvedValue(summary());
    const { status } = await narrateCard({
      ctx,
      card: sampleWeeklyCard({ isMock: false }),
      findings: [],
      mode: "allow",
    });
    expect(status).toBe("ok");
    expect(reasoning.run).toHaveBeenCalledTimes(1);
  });
});
