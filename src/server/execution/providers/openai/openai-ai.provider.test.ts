import { beforeEach, describe, expect, it, vi } from "vitest";

const openaiMocks = vi.hoisted(() => ({
  isConfigured: true,
  runOpenAIText: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => openaiMocks.isConfigured,
  openaiModelForTier: () => "gpt-test",
  runOpenAIText: openaiMocks.runOpenAIText,
}));

const searchMocks = vi.hoisted(() => ({
  runOpenAITextWithSearch: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-search-client", () => ({
  runOpenAITextWithSearch: searchMocks.runOpenAITextWithSearch,
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

import { OpenAiAiProvider } from "@/server/execution/providers/openai/openai-ai.provider";
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

describe("OpenAiAiProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiMocks.isConfigured = true;
    prismaMocks.findUniqueExecutionJob.mockResolvedValue(undefined);
    prismaMocks.updateExecutionJob.mockResolvedValue({});
  });

  describe("isConfigured / canExecute", () => {
    it("mirrors isOpenAIConfigured", () => {
      const provider = new OpenAiAiProvider();
      expect(provider.isConfigured).toBe(true);
      openaiMocks.isConfigured = false;
      expect(provider.isConfigured).toBe(false);
    });

    it("owns the text/analysis capability family", async () => {
      const provider = new OpenAiAiProvider();
      expect(await provider.canExecute("REPORTING")).toBe(true);
      expect(await provider.canExecute("CREATE_COPY")).toBe(true);
    });

    it("claims the public-web research capabilities (served via web_search)", async () => {
      const provider = new OpenAiAiProvider();
      expect(await provider.canExecute("BRAND_DISCOVERY")).toBe(true);
      expect(await provider.canExecute("WEB_RESEARCH")).toBe(true);
      expect(await provider.canExecute("COMPETITOR_RESEARCH")).toBe(true);
      expect(await provider.canExecute("SEO_RESEARCH")).toBe(true);
    });

    // A plain-text model can't open a browser or observe a published post, so
    // the browser-only capabilities stay unserved instead of being faked.
    it("does not claim the browser-only capabilities", async () => {
      const provider = new OpenAiAiProvider();
      expect(await provider.canExecute("SOCIAL_ACCOUNT_SETUP")).toBe(false);
      expect(await provider.canExecute("SOCIAL_PROFILE_AUDIT")).toBe(false);
      expect(await provider.canExecute("SIGNAL_SCAN")).toBe(false);
      expect(await provider.canExecute("MEASUREMENT_CHECK")).toBe(false);
    });

    it("does not claim creative or unrelated capabilities", async () => {
      const provider = new OpenAiAiProvider();
      expect(await provider.canExecute("CREATE_SOCIAL_CREATIVE")).toBe(false);
      expect(await provider.canExecute("EMAIL_SEND")).toBe(false);
    });
  });

  describe("execute / getStatus", () => {
    it("completes with the model's text on success", async () => {
      openaiMocks.runOpenAIText.mockResolvedValue({ text: "the report" });

      const provider = new OpenAiAiProvider();
      const accepted = await provider.execute(request("REPORTING"));
      expect(accepted).toEqual({ executionReference: "corr-1", isMock: false });

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "COMPLETED",
        rawResult: { text: "the report" },
        isMock: false,
      });
      expect(openaiMocks.runOpenAIText).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gpt-test", maxOutputTokens: 4096 }),
      );
    });

    it("runs research capabilities through web search, not plain text", async () => {
      searchMocks.runOpenAITextWithSearch.mockResolvedValue({
        text: "sourced research report",
        webSearchCalls: 3,
      });

      const provider = new OpenAiAiProvider();
      await provider.execute(request("COMPETITOR_RESEARCH"));

      expect(openaiMocks.runOpenAIText).not.toHaveBeenCalled();
      expect(searchMocks.runOpenAITextWithSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-test",
          maxOutputTokens: 8192,
          system: expect.stringContaining("web_search"),
        }),
      );
      expect(await provider.getStatus("corr-1")).toEqual({
        status: "COMPLETED",
        rawResult: { text: "sourced research report" },
        isMock: false,
      });
    });

    it("keeps non-research capabilities off web search", async () => {
      openaiMocks.runOpenAIText.mockResolvedValue({ text: "the report" });

      const provider = new OpenAiAiProvider();
      await provider.execute(request("REPORTING"));

      expect(searchMocks.runOpenAITextWithSearch).not.toHaveBeenCalled();
    });

    it("reports FAILED with the error message when the call throws", async () => {
      openaiMocks.runOpenAIText.mockRejectedValue(new Error("quota exceeded"));

      const provider = new OpenAiAiProvider();
      await provider.execute(request("REPORTING"));

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "quota exceeded",
        isMock: false,
      });
    });

    it("returns FAILED for an unknown execution reference", async () => {
      const provider = new OpenAiAiProvider();
      const status = await provider.getStatus("never-executed");
      expect(status.status).toBe("FAILED");
    });
  });

  // Audit problem 13: the in-memory `store` Map is process-local — a
  // Railway redeploy/crash between execute() and the next getStatus() poll
  // wipes it, and getStatus() used to unconditionally report "Unknown
  // OpenAI execution reference" for that job even though the OpenAI call
  // had already completed. execute() now persists the terminal result into
  // ExecutionJob.rawResult so getStatus() can recover it from Postgres.
  describe("durable execution state (process restart recovery)", () => {
    it("persists the completed result to ExecutionJob.rawResult when execute() succeeds", async () => {
      openaiMocks.runOpenAIText.mockResolvedValue({ text: "the report" });

      const provider = new OpenAiAiProvider();
      await provider.execute(request("REPORTING"));

      expect(prismaMocks.updateExecutionJob).toHaveBeenCalledWith({
        where: { id: "job-1" },
        data: {
          rawResult: { status: "completed", text: "the report" },
        },
      });
    });

    it("persists the failed result to ExecutionJob.rawResult when execute() throws", async () => {
      openaiMocks.runOpenAIText.mockRejectedValue(new Error("quota exceeded"));

      const provider = new OpenAiAiProvider();
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
      openaiMocks.runOpenAIText.mockResolvedValue({ text: "the report" });

      const provider = new OpenAiAiProvider();
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

      // A fresh provider instance changes nothing here — `store` is a
      // module-level singleton — but this is deliberately a correlationId
      // that this test never calls execute() with, so the in-memory Map is
      // guaranteed to miss exactly like it would after a real restart.
      const provider = new OpenAiAiProvider();
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

      const provider = new OpenAiAiProvider();
      const status = await provider.getStatus("restart-corr-failed");

      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "boom",
        isMock: false,
      });
    });

    it("still returns FAILED for an unknown reference when neither the in-memory store nor Postgres has it", async () => {
      prismaMocks.findUniqueExecutionJob.mockResolvedValue(null);

      const provider = new OpenAiAiProvider();
      const status = await provider.getStatus("truly-never-executed");

      expect(status.status).toBe("FAILED");
      expect(status.errorMessage).toBe("Unknown OpenAI execution reference");
    });
  });
});
