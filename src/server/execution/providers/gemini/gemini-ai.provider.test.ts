import { beforeEach, describe, expect, it, vi } from "vitest";

const geminiMocks = vi.hoisted(() => ({
  isConfigured: true,
  runGeminiText: vi.fn(),
  runGeminiWithSearchGrounding: vi.fn(),
}));
vi.mock("@/server/reasoning/gemini-client", () => ({
  isGeminiConfigured: () => geminiMocks.isConfigured,
  geminiModelForTier: () => "gemini-test",
  runGeminiText: geminiMocks.runGeminiText,
  runGeminiWithSearchGrounding: geminiMocks.runGeminiWithSearchGrounding,
}));

const prismaMocks = vi.hoisted(() => ({
  findUniqueExecutionJob: vi.fn(),
  updateExecutionJob: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    executionJob: {
      findUnique: prismaMocks.findUniqueExecutionJob,
      update: prismaMocks.updateExecutionJob,
    },
  },
}));

import { GeminiAiProvider } from "@/server/execution/providers/gemini/gemini-ai.provider";
import type { ExecutionRequest } from "@/server/execution/types";

function request(
  capability: ExecutionRequest["capability"],
  payload: unknown = { request: "analyze this" },
): ExecutionRequest {
  return {
    executionJobId: "job-1",
    correlationId: "corr-1",
    idempotencyKey: "task-1:capability",
    capability,
    context: {
      workspaceId: "ws-1",
      projectId: "project-1",
      brandId: "brand-1",
      taskId: "task-1",
      capability,
      riskLevel: "LOW",
    },
    payload,
  };
}

describe("GeminiAiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geminiMocks.isConfigured = true;
    prismaMocks.findUniqueExecutionJob.mockResolvedValue(undefined);
    prismaMocks.updateExecutionJob.mockResolvedValue({});
  });

  describe("isConfigured / canExecute", () => {
    it("mirrors isGeminiConfigured", () => {
      const provider = new GeminiAiProvider();
      expect(provider.isConfigured).toBe(true);
      geminiMocks.isConfigured = false;
      expect(provider.isConfigured).toBe(false);
    });

    it("owns the text/analysis capability family", async () => {
      const provider = new GeminiAiProvider();
      expect(await provider.canExecute("REPORTING")).toBe(true);
      expect(await provider.canExecute("CREATE_COPY")).toBe(true);
    });

    // Unlike OpenAiAiProvider, Gemini's native Google Search grounding tool
    // answers these directly — it claims all 4, with OpenClawProvider as
    // its fallback (see provider-registry.ts).
    it("claims the search-grounded research capabilities", async () => {
      const provider = new GeminiAiProvider();
      expect(await provider.canExecute("BRAND_DISCOVERY")).toBe(true);
      expect(await provider.canExecute("WEB_RESEARCH")).toBe(true);
      expect(await provider.canExecute("COMPETITOR_RESEARCH")).toBe(true);
      expect(await provider.canExecute("SEO_RESEARCH")).toBe(true);
    });

    it("does not claim creative or unrelated capabilities", async () => {
      const provider = new GeminiAiProvider();
      expect(await provider.canExecute("CREATE_SOCIAL_CREATIVE")).toBe(false);
      expect(await provider.canExecute("EMAIL_SEND")).toBe(false);
    });
  });

  describe("execute / getStatus", () => {
    it("completes with the model's text on success, using plain text generation for non-search capabilities", async () => {
      geminiMocks.runGeminiText.mockResolvedValue({ text: "the report" });

      const provider = new GeminiAiProvider();
      const accepted = await provider.execute(request("REPORTING"));
      expect(accepted).toEqual({ executionReference: "corr-1", isMock: false });

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "COMPLETED",
        rawResult: { text: "the report" },
        isMock: false,
      });
      expect(geminiMocks.runGeminiText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-test",
          maxOutputTokens: 4096,
        }),
      );
      expect(geminiMocks.runGeminiWithSearchGrounding).not.toHaveBeenCalled();
    });

    it("uses search grounding for the 4 search-grounded capabilities", async () => {
      geminiMocks.runGeminiWithSearchGrounding.mockResolvedValue({
        text: "grounded findings",
      });

      const provider = new GeminiAiProvider();
      await provider.execute(request("WEB_RESEARCH"));

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "COMPLETED",
        rawResult: { text: "grounded findings" },
        isMock: false,
      });
      expect(geminiMocks.runGeminiWithSearchGrounding).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gemini-test",
          maxOutputTokens: 4096,
        }),
      );
      expect(geminiMocks.runGeminiText).not.toHaveBeenCalled();
    });

    it("reports FAILED with the error message when the call throws", async () => {
      geminiMocks.runGeminiText.mockRejectedValue(new Error("quota exceeded"));

      const provider = new GeminiAiProvider();
      await provider.execute(request("REPORTING"));

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "quota exceeded",
        isMock: false,
      });
    });

    it("returns FAILED for an unknown execution reference", async () => {
      const provider = new GeminiAiProvider();
      const status = await provider.getStatus("never-executed");
      expect(status.status).toBe("FAILED");
    });
  });

  // Same durability pattern as OpenAiAiProvider (see its test suite's
  // "Audit problem 13" comment): the in-memory `store` Map is process-local
  // — execute() also persists the terminal result into ExecutionJob.rawResult
  // so getStatus() can recover it from Postgres after a restart.
  describe("durable execution state (process restart recovery)", () => {
    it("persists the completed result to ExecutionJob.rawResult when execute() succeeds", async () => {
      geminiMocks.runGeminiText.mockResolvedValue({ text: "the report" });

      const provider = new GeminiAiProvider();
      await provider.execute(request("REPORTING"));

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: { status: "completed", text: "the report" },
        },
      });
    });

    it("persists the failed result to ExecutionJob.rawResult when execute() throws", async () => {
      geminiMocks.runGeminiText.mockRejectedValue(new Error("quota exceeded"));

      const provider = new GeminiAiProvider();
      await provider.execute(request("REPORTING"));

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: { status: "failed", errorMessage: "quota exceeded" },
        },
      });
    });

    it("merges into any existing rawResult instead of overwriting it", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue({
        rawResult: { keepMe: "already-there" },
      });
      geminiMocks.runGeminiText.mockResolvedValue({ text: "the report" });

      const provider = new GeminiAiProvider();
      await provider.execute(request("REPORTING"));

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: {
            keepMe: "already-there",
            status: "completed",
            text: "the report",
          },
        },
      });
    });

    it("recovers a completed result from Postgres when the in-memory store has no entry (simulated process restart)", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue({
        rawResult: { status: "completed", text: "recovered text" },
      });

      const provider = new GeminiAiProvider();
      const status = await provider.getStatus("restart-corr-completed");

      expect(status).toEqual({
        status: "COMPLETED",
        rawResult: { text: "recovered text" },
        isMock: false,
      });
      expect(prismaMocks.findUniqueExecutionJob).toHaveBeenCalledWith({
        where: { correlationId: "restart-corr-completed" },
        select: { rawResult: true },
      });
    });

    it("recovers a failed result from Postgres when the in-memory store has no entry (simulated process restart)", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue({
        rawResult: { status: "failed", errorMessage: "boom" },
      });

      const provider = new GeminiAiProvider();
      const status = await provider.getStatus("restart-corr-failed");

      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "boom",
        isMock: false,
      });
    });

    it("still returns FAILED for an unknown reference when neither the in-memory store nor Postgres has it", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue(null);

      const provider = new GeminiAiProvider();
      const status = await provider.getStatus("truly-never-executed");

      expect(status.status).toBe("FAILED");
      expect(status.errorMessage).toBe("Unknown Gemini execution reference");
    });
  });
});
