import { beforeEach, describe, expect, it, vi } from "vitest";

// A completed task's free-text report is turned into findings with an LLM
// call. That belongs to research and scans. A deliverable (copy, a brief, a
// report) is the agency's own writing: mining it cost a call per task and
// filed it back as "research evidence" that insight synthesis read as market
// facts.

const taskFindUnique = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { task: { findUnique: taskFindUnique } },
}));

const run = vi.fn();
vi.mock("@/server/reasoning/reasoning-service", () => ({
  ReasoningService: { run },
}));
vi.mock("@/server/reasoning/prompts/research-extraction", () => ({
  researchExtractionDef: {},
}));

const writeMany = vi.fn();
vi.mock("./finding-writer", () => ({ FindingWriter: { writeMany } }));
vi.mock("./competitor-materializer", () => ({
  CompetitorMaterializer: { materialize: vi.fn() },
}));
vi.mock("@/server/repositories/signal.repository", () => ({
  SignalRepository: { create: vi.fn() },
}));

const { ResultMaterializer, shouldExtractFindings } = await import(
  "./research-result-materializer"
);
const { isBackground, runAsBackground } =
  await import("@/server/billing/usage-context");

const LONG_REPORT = "A long report about the market. ".repeat(10);

function completedTask(
  capability: string,
  rawResult: unknown,
  createdByType: "USER" | "SYSTEM" | "AI" = "SYSTEM",
) {
  return {
    id: "task-1",
    workspaceId: "ws-1",
    projectId: "proj-1",
    brandId: "brand-1",
    capability,
    status: "COMPLETED",
    createdByType,
    executionJobs: [{ rawResult }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({
    output: {
      findings: [
        {
          statement: "Acme is the market leader.",
          classification: "LIKELY_FACT",
        },
      ],
    },
  });
  writeMany.mockResolvedValue([{ id: "f1" }]);
});

describe("shouldExtractFindings", () => {
  it.each([
    "CREATE_COPY",
    "CREATE_CAPTION",
    "CREATE_CAMPAIGN_BRIEF",
    "EMAIL_DRAFT",
    "REPORTING",
    "INSTAGRAM_PUBLISH",
    "META_CAMPAIGN_CREATE",
  ])("does not mine %s, a deliverable", (capability) => {
    expect(shouldExtractFindings(capability)).toBe(false);
  });

  it.each([
    "WEB_RESEARCH",
    "COMPETITOR_RESEARCH",
    "MARKET_RESEARCH",
    "SEO_RESEARCH",
    "SIGNAL_SCAN",
    "BRAND_DISCOVERY",
    "MEASUREMENT_CHECK",
    // Unknown or future capabilities default to mined, so research is never
    // silently dropped.
    "SOME_FUTURE_CAPABILITY",
  ])("still mines %s", (capability) => {
    expect(shouldExtractFindings(capability)).toBe(true);
  });
});

describe("ResultMaterializer.materializeTask", () => {
  it("makes no LLM call and writes no findings for a piece of copy", async () => {
    taskFindUnique.mockResolvedValue(
      completedTask("CREATE_COPY", { text: LONG_REPORT }),
    );

    const result = await ResultMaterializer.materializeTask("task-1");

    expect(result).toEqual({ findings: 0, signals: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(writeMany).not.toHaveBeenCalled();
  });

  it("extracts findings from a research report as before", async () => {
    taskFindUnique.mockResolvedValue(
      completedTask("WEB_RESEARCH", { final: LONG_REPORT }),
    );

    const result = await ResultMaterializer.materializeTask("task-1");

    expect(run).toHaveBeenCalledTimes(1);
    expect(writeMany).toHaveBeenCalled();
    expect(result.findings).toBe(1);
  });

  // The extraction call is paid for from the plan (billing, Faz 3C). It runs in the
  // tick's trigger step, but it works on a task's result: whose call it is follows
  // who created the task, so a person's own research is never held to the share the
  // system's own work gets.
  describe("whose call the extraction is", () => {
    const labelsSeenByExtraction = () => {
      const seen: boolean[] = [];
      run.mockImplementation(async () => {
        seen.push(isBackground());
        return { output: { findings: [] } };
      });
      return seen;
    };

    it("is the user's for a task the user created, even inside a background step", async () => {
      const seen = labelsSeenByExtraction();
      taskFindUnique.mockResolvedValue(
        completedTask("WEB_RESEARCH", { final: LONG_REPORT }, "USER"),
      );

      await runAsBackground(() => ResultMaterializer.materializeTask("task-1"));

      expect(seen).toEqual([false]);
    });

    it.each(["SYSTEM", "AI"] as const)(
      "is the system's for a task created by %s, with or without a background step around it",
      async (createdByType) => {
        const seen = labelsSeenByExtraction();
        taskFindUnique.mockResolvedValue(
          completedTask("WEB_RESEARCH", { final: LONG_REPORT }, createdByType),
        );

        await ResultMaterializer.materializeTask("task-1");
        await runAsBackground(() =>
          ResultMaterializer.materializeTask("task-1"),
        );

        expect(seen).toEqual([true, true]);
      },
    );

    it("does not leave a label behind", async () => {
      labelsSeenByExtraction();
      taskFindUnique.mockResolvedValue(
        completedTask("WEB_RESEARCH", { final: LONG_REPORT }, "SYSTEM"),
      );

      await ResultMaterializer.materializeTask("task-1");

      expect(isBackground()).toBe(false);
    });
  });

  it("still writes structured findings a deliverable task happens to return", async () => {
    // The gate only skips the LLM extraction of prose; a provider that hands
    // back structured findings on its own keeps working.
    taskFindUnique.mockResolvedValue(
      completedTask("CREATE_COPY", {
        findings: [
          { statement: "Buyers ask about price.", classification: "LIKELY_FACT" },
        ],
      }),
    );

    const result = await ResultMaterializer.materializeTask("task-1");

    expect(run).not.toHaveBeenCalled();
    expect(writeMany).toHaveBeenCalled();
    expect(result.findings).toBe(1);
  });

  it("ignores a task that is not completed", async () => {
    taskFindUnique.mockResolvedValue({
      ...completedTask("WEB_RESEARCH", { final: LONG_REPORT }),
      status: "FAILED",
    });

    await expect(ResultMaterializer.materializeTask("task-1")).resolves.toEqual(
      { findings: 0, signals: 0 },
    );
    expect(run).not.toHaveBeenCalled();
  });
});
