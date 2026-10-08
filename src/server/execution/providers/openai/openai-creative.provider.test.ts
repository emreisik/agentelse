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

// The art director has its own tests; here the text step's own prompt stands.
vi.mock("@/server/media/art-director", () => ({
  directImage: vi.fn().mockResolvedValue(null),
}));

// isCreativeImageConfigured reflects the REAL provider env vars — in this
// dev checkout those are genuinely configured, so without this mock
// isCreativeImageConfigured() returns true and execute() attempts a real,
// billed image-generation call (confirmed: an earlier version of this
// test file hung for 5s doing exactly that). Force it off so this test
// suite can never make a real network call no matter the local .env.
vi.mock("@/server/media/creative-image", () => ({
  generateCreativeImage: vi.fn(),
  isCreativeImageConfigured: () => false,
}));
// Not exercised when isCreativeImageConfigured() is false (no image means
// no template compositing — see the provider's `if (image)` guard), but
// mocked anyway so a future test enabling image generation can't
// accidentally fall through to the real prisma-backed implementation.
// The copywriter step is covered by its own tests; here the model's draft stands.
vi.mock("@/server/media/headline-copywriter", () => ({
  writeOnImageText: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/server/media/creative-template", () => ({
  applyBrandTemplate: vi.fn(),
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

    // Previously input.contentFormat was never read here at all — every
    // request, regardless of what the chat message asked for, resolved to
    // the platform's default format (see intent-router.ts/chat-turn.ts's
    // matching fix). getCreativePlatformFormat is not mocked here
    // deliberately — this proves the REAL function resolves "STORY" to a
    // real FORMAT_MATRIX entry, not just that the input was read.
    it("resolves a chat-requested contentFormat (Story) instead of the platform default", async () => {
      openaiMocks.runOpenAIStructured.mockResolvedValue({
        raw: {
          caption: "caption",
          copy: "copy",
          imagePrompt: "a product shot",
        },
      });

      const provider = new OpenAiCreativeProvider();
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
