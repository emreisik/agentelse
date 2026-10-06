import { beforeEach, describe, expect, it, vi } from "vitest";

import { allowedNumbersOf } from "@/lib/module-flows/analytics/number-check";
import { NARRATIVE_NOTE } from "@/lib/seo/reports/text";
import type { SeoReportKind, SeoReportSnapshot } from "@/lib/seo/reports/types";
import { AgentelseError } from "@/server/security/errors";

// Bu dosyanın kanıtladığı: mock kipte ve sahte bağda model çağrılmaz; PULSE ve
// yol haritası için çağrı yok; "Non-brand clicks fell 12.3%" cümlesi −12.3'lük
// değişimle eşleşir (izinli sayılar işaretten bağımsız), uydurma rakamlı
// cümle atılır, hepsi uydurmaysa "dropped" notu yazılır; günlük bütçe ve
// günlük akıl yürütme sınırı "budget", zaman aşımı ve sağlayıcı yok "failed"
// notu olur; hata MESAJI loga girmez.

const reasoning = vi.hoisted(() => ({
  isMockMode: vi.fn<() => boolean>(),
  run: vi.fn(),
}));
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: reasoning,
}));

const FACTS = {
  report: "weekly",
  period: "Sep 28 – Oct 4",
  kpis: [{ metric: "Non-brand clicks", value: "1,234", changePct: -12.3 }],
};
vi.mock("@/lib/seo/reports/facts", () => ({
  seoNarrativeFacts: () => ({ facts: FACTS, googleStrings: 0 }),
  narrativeAllowedNumbers: (facts: unknown) => {
    const numbers = allowedNumbersOf(facts);
    return [...numbers, ...numbers.map((value) => Math.abs(value))];
  },
}));

const { narrativeNoteForError, writeSeoNarrative } = await import(
  "./narrative"
);

const SCOPE = { workspaceId: "ws-1", projectId: "proj-1", brandId: "brand-1" };

function snapshot(kind: SeoReportKind): SeoReportSnapshot {
  return { kind } as unknown as SeoReportSnapshot;
}

function answer(partial: Partial<Record<string, unknown>> = {}) {
  return {
    output: {
      headline: "Search traffic held up.",
      highlights: [],
      watchouts: [],
      nextSteps: [],
      ...partial,
    },
    isMock: false,
    reasoningCallId: "call-1",
  };
}

beforeEach(() => {
  reasoning.isMockMode.mockReset().mockReturnValue(false);
  reasoning.run.mockReset();
  vi.restoreAllMocks();
});

describe("writeSeoNarrative", () => {
  it("skips the model in reasoning mock mode", async () => {
    reasoning.isMockMode.mockReturnValue(true);
    const outcome = await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), {
      mockLink: false,
    });
    expect(outcome).toEqual({ narrative: null, note: NARRATIVE_NOTE.mock });
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it("skips the model for a sample-data link even with real reasoning", async () => {
    const outcome = await writeSeoNarrative(SCOPE, snapshot("MONTHLY"), {
      mockLink: true,
    });
    expect(outcome).toEqual({ narrative: null, note: NARRATIVE_NOTE.mock });
    expect(reasoning.run).not.toHaveBeenCalled();
  });

  it.each<SeoReportKind>(["PULSE", "ROADMAP"])(
    "makes no call for %s",
    async (kind) => {
      const outcome = await writeSeoNarrative(SCOPE, snapshot(kind), {
        mockLink: false,
      });
      expect(outcome).toEqual({ narrative: null, note: null });
      expect(reasoning.run).not.toHaveBeenCalled();
    },
  );

  it("keeps 'fell 12.3%' for a -12.3 change and drops a fabricated number", async () => {
    reasoning.run.mockResolvedValue(
      answer({
        headline: "Non-brand clicks fell 12.3%.",
        highlights: ["Clicks grew by 987,654 percent."],
        nextSteps: ["Refresh the page that lost the most clicks."],
      }),
    );
    const outcome = await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), {
      mockLink: false,
    });
    expect(outcome.note).toBeNull();
    expect(outcome.narrative?.headline).toBe("Non-brand clicks fell 12.3%.");
    expect(outcome.narrative?.highlights).toEqual([]);
    expect(outcome.narrative?.nextSteps).toEqual([
      "Refresh the page that lost the most clicks.",
    ]);
    expect(reasoning.run).toHaveBeenCalledTimes(1);
  });

  it("passes the facts, the scope and nothing else to the model", async () => {
    reasoning.run.mockResolvedValue(answer());
    await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), { mockLink: false });
    const [, input] = reasoning.run.mock.calls[0] as [unknown, unknown];
    expect(input).toEqual({ ...SCOPE, context: { facts: FACTS } });
  });

  it("writes the dropped note when every sentence is fabricated", async () => {
    reasoning.run.mockResolvedValue(
      answer({ headline: "Clicks grew by 987,654 percent." }),
    );
    const outcome = await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), {
      mockLink: false,
    });
    expect(outcome).toEqual({ narrative: null, note: NARRATIVE_NOTE.dropped });
  });

  it.each(["daily-budget", "daily-reasoning"])(
    "writes the budget note for a %s limit",
    async (reason) => {
      const limit =
        reason === "daily-budget" ? "dailyBudgetUsd" : "maxReasoningCallsPerDay";
      reasoning.run.mockRejectedValue(
        new AgentelseError("BUDGET_EXCEEDED", "cap", { meta: { limit } }),
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const outcome = await writeSeoNarrative(SCOPE, snapshot("MONTHLY"), {
        mockLink: false,
      });
      expect(outcome).toEqual({ narrative: null, note: NARRATIVE_NOTE.budget });
    },
  );

  it.each(["TIMEOUT", "PROVIDER_UNAVAILABLE"] as const)(
    "writes the failed note for %s",
    async (code) => {
      reasoning.run.mockRejectedValue(new AgentelseError(code, "boom"));
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const outcome = await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), {
        mockLink: false,
      });
      expect(outcome).toEqual({ narrative: null, note: NARRATIVE_NOTE.failed });
    },
  );

  it("never logs the error message, only its name", async () => {
    reasoning.run.mockRejectedValue(new Error("query: cheap flights to rome"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await writeSeoNarrative(SCOPE, snapshot("WEEKLY"), {
      mockLink: false,
    });
    expect(outcome.note).toBe(NARRATIVE_NOTE.failed);
    expect(JSON.stringify(log.mock.calls)).not.toContain("rome");
  });
});

describe("narrativeNoteForError", () => {
  it("maps anything that is not a daily limit to the failed note", () => {
    expect(narrativeNoteForError(new Error("x"))).toBe(NARRATIVE_NOTE.failed);
    expect(
      narrativeNoteForError(new AgentelseError("PROVIDER_RATE_LIMITED", "x")),
    ).toBe(NARRATIVE_NOTE.failed);
  });
});
