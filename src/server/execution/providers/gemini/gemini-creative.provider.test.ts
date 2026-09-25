import { beforeEach, describe, expect, it, vi } from "vitest";

const geminiMocks = vi.hoisted(() => ({
  isConfigured: true,
  runGeminiStructured: vi.fn(),
}));
vi.mock("@/server/reasoning/gemini-client", () => ({
  isGeminiConfigured: () => geminiMocks.isConfigured,
  geminiModelForTier: () => "gemini-test",
  runGeminiStructured: geminiMocks.runGeminiStructured,
}));

// isCreativeImageConfigured reflects the REAL provider env vars — in this
// dev checkout those are genuinely configured, so without this mock a
// test that reaches execute()'s success path attempts a real, billed
// image-generation call (confirmed on the sibling openai-creative
// provider test — see its identical mock for the incident). Force it off
// so this suite can never make a real network call no matter the local
// .env.
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage: vi.fn(),
  isCreativeImageConfigured: () => false,
}));
vi.mock("@/server/media/creative-template", () => ({
  applyBrandTemplate: vi.fn(),
}));

import { GeminiCreativeProvider } from "@/server/execution/providers/gemini/gemini-creative.provider";
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

describe("GeminiCreativeProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    geminiMocks.isConfigured = true;
  });

  describe("isConfigured / canExecute", () => {
    it("mirrors isGeminiConfigured", () => {
      const provider = new GeminiCreativeProvider();
      expect(provider.isConfigured).toBe(true);
      geminiMocks.isConfigured = false;
      expect(provider.isConfigured).toBe(false);
    });

    it("owns exactly the two creative capabilities", async () => {
      const provider = new GeminiCreativeProvider();
      expect(await provider.canExecute("CREATE_SOCIAL_CREATIVE")).toBe(true);
      expect(await provider.canExecute("CREATE_AD_CREATIVE")).toBe(true);
      expect(await provider.canExecute("CREATE_COPY")).toBe(false);
      expect(await provider.canExecute("REPORTING")).toBe(false);
    });
  });

  describe("execute / getStatus", () => {
    it("reports FAILED with the error message when the structured call throws", async () => {
      geminiMocks.runGeminiStructured.mockRejectedValue(
        new Error("quota exceeded"),
      );

      const provider = new GeminiCreativeProvider();
      await provider.execute(request("CREATE_SOCIAL_CREATIVE"));

      const status = await provider.getStatus("corr-1");
      expect(status).toEqual({
        status: "FAILED",
        errorMessage: "quota exceeded",
        isMock: false,
      });
    });

    it("returns FAILED for an unknown execution reference", async () => {
      const provider = new GeminiCreativeProvider();
      const status = await provider.getStatus("never-executed");
      expect(status.status).toBe("FAILED");
    });

    // See the sibling openai-creative.provider.test.ts for the fuller
    // comment — a chat-requested Story/Reel previously had no way to
    // reach getCreativePlatformFormat at all, on either creative provider.
    it("resolves a chat-requested contentFormat (Story) instead of the platform default", async () => {
      geminiMocks.runGeminiStructured.mockResolvedValue({
        raw: {
          caption: "caption",
          copy: "copy",
          imagePrompt: "a product shot",
        },
      });

      const provider = new GeminiCreativeProvider();
      await provider.execute(
        request("CREATE_SOCIAL_CREATIVE", {
          request: "a creative brief",
          platform: "INSTAGRAM",
          contentFormat: "STORY",
        }),
      );

      const status = await provider.getStatus("corr-1");
      expect(status.status).toBe("COMPLETED");
      if (status.status === "COMPLETED") {
        const rawResult = status.rawResult as { contentFormat?: string };
        expect(rawResult.contentFormat).toBe("STORY");
      }
    });
  });
});
