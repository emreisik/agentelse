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

    // OpenAI's Chat Completions API has no built-in web-search tool — these
    // 4 stay on OpenClawProvider's real browser-based research instead (see
    // the provider's own comment for the full rationale).
    it("does not claim the search-grounded research capabilities", async () => {
      const provider = new OpenAiAiProvider();
      expect(await provider.canExecute("BRAND_DISCOVERY")).toBe(false);
      expect(await provider.canExecute("WEB_RESEARCH")).toBe(false);
      expect(await provider.canExecute("COMPETITOR_RESEARCH")).toBe(false);
      expect(await provider.canExecute("SEO_RESEARCH")).toBe(false);
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
});
