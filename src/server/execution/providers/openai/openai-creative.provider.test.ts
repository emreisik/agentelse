import { beforeEach, describe, expect, it, vi } from "vitest";

const openaiMocks = vi.hoisted(() => ({
  isConfigured: true,
  runOpenAIStructured: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => openaiMocks.isConfigured,
  openaiModelForTier: () => "gpt-test",
  runOpenAIStructured: openaiMocks.runOpenAIStructured,
}));

import { OpenAiCreativeProvider } from "@/server/execution/providers/openai/openai-creative.provider";
import type { ExecutionRequest } from "@/server/execution/types";

function request(
  capability: ExecutionRequest["capability"],
  payload: unknown = { request: "a creative brief" },
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

describe("OpenAiCreativeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiMocks.isConfigured = true;
  });

  describe("isConfigured / canExecute", () => {
    it("mirrors isOpenAIConfigured", () => {
      const provider = new OpenAiCreativeProvider();
      expect(provider.isConfigured).toBe(true);
      openaiMocks.isConfigured = false;
      expect(provider.isConfigured).toBe(false);
    });

    it("owns exactly the two creative capabilities", async () => {
      const provider = new OpenAiCreativeProvider();
      expect(await provider.canExecute("CREATE_SOCIAL_CREATIVE")).toBe(true);
      expect(await provider.canExecute("CREATE_AD_CREATIVE")).toBe(true);
      expect(await provider.canExecute("CREATE_COPY")).toBe(false);
      expect(await provider.canExecute("REPORTING")).toBe(false);
    });
  });

  describe("execute / getStatus", () => {
    it("reports FAILED with the error message when the structured call throws", async () => {
      openaiMocks.runOpenAIStructured.mockRejectedValue(
        new Error("quota exceeded"),
      );

      const provider = new OpenAiCreativeProvider();
      await provider.execute(request("CREATE_SOCIAL_CREATIVE"));

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "quota exceeded",
        isMock: false,
      });
    });

    it("returns FAILED for an unknown execution reference", async () => {
      const provider = new OpenAiCreativeProvider();
      const status = await provider.getStatus("never-executed");
      expect(status.status).toBe("FAILED");
    });
  });
});
