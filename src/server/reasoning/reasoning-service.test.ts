import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const envMocks = vi.hoisted(() => ({
  REASONING_PROVIDER: "gemini" as "gemini" | "openai",
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ REASONING_PROVIDER: envMocks.REASONING_PROVIDER }),
}));

const openaiMocks = vi.hoisted(() => ({
  isConfigured: true,
  modelForTier: vi.fn(() => "gpt-5.6-luna"),
  runStructured: vi.fn(),
}));
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => openaiMocks.isConfigured,
  openaiModelForTier: openaiMocks.modelForTier,
  runOpenAIStructured: openaiMocks.runStructured,
}));

const geminiMocks = vi.hoisted(() => ({
  isConfigured: true,
  modelForTier: vi.fn(() => "gemini-3.6-flash"),
  runStructured: vi.fn(),
}));
vi.mock("@/server/reasoning/gemini-client", () => ({
  isGeminiConfigured: () => geminiMocks.isConfigured,
  geminiModelForTier: geminiMocks.modelForTier,
  runGeminiStructured: geminiMocks.runStructured,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: {
    checkAndIncrement: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: {
    record: vi.fn().mockResolvedValue({ id: "call-1" }),
  },
}));

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isAgentelseError } from "@/server/security/errors";
import type { ReasoningDef, ReasoningInput } from "@/server/reasoning/types";

const schema = z.object({ value: z.string() });

function def(
  overrides: Partial<ReasoningDef<{ value: string }>> = {},
): ReasoningDef<{
  value: string;
}> {
  return {
    purpose: "test.purpose",
    schema,
    buildPrompt: () => ({ system: "sys", user: "usr" }),
    buildMock: () => ({ value: "mocked" }),
    ...overrides,
  };
}

const input: ReasoningInput = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  context: {},
};

describe("ReasoningService.run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.REASONING_PROVIDER = "gemini";
    openaiMocks.isConfigured = true;
    geminiMocks.isConfigured = true;
    geminiMocks.runStructured.mockResolvedValue({
      raw: { value: "gemini-out" },
    });
    openaiMocks.runStructured.mockResolvedValue({
      raw: { value: "openai-out" },
    });
  });

  afterEach(() => {
    delete process.env.AGENTELSE_REASONING_MODE;
  });

  it("uses the mock builder and never calls a real provider when AGENTELSE_REASONING_MODE=mock", async () => {
    process.env.AGENTELSE_REASONING_MODE = "mock";

    const result = await ReasoningService.run(def(), input);

    expect(result).toEqual({
      output: { value: "mocked" },
      isMock: true,
      reasoningCallId: "call-1",
    });
    expect(geminiMocks.runStructured).not.toHaveBeenCalled();
    expect(openaiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("defaults to Gemini when REASONING_PROVIDER is unset/gemini", async () => {
    envMocks.REASONING_PROVIDER = "gemini";

    const result = await ReasoningService.run(def(), input);

    expect(result.output).toEqual({ value: "gemini-out" });
    expect(geminiMocks.runStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.6-flash" }),
    );
    expect(openaiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("switches to OpenAI when REASONING_PROVIDER=openai", async () => {
    envMocks.REASONING_PROVIDER = "openai";

    const result = await ReasoningService.run(def(), input);

    expect(result.output).toEqual({ value: "openai-out" });
    expect(openaiMocks.runStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
    );
    expect(geminiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("a def.model pin overrides REASONING_PROVIDER by the model's own family (gpt- pin while provider=gemini)", async () => {
    envMocks.REASONING_PROVIDER = "gemini";

    const result = await ReasoningService.run(
      def({ model: "gpt-5.4-mini" }),
      input,
    );

    expect(result.output).toEqual({ value: "openai-out" });
    expect(openaiMocks.runStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4-mini" }),
    );
    expect(geminiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("a def.model pin overrides REASONING_PROVIDER by the model's own family (gemini pin while provider=openai)", async () => {
    envMocks.REASONING_PROVIDER = "openai";

    const result = await ReasoningService.run(
      def({ model: "gemini-3.1-pro-preview" }),
      input,
    );

    expect(result.output).toEqual({ value: "gemini-out" });
    expect(geminiMocks.runStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gemini-3.1-pro-preview" }),
    );
    expect(openaiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("throws PROVIDER_UNAVAILABLE when the resolved backend isn't configured", async () => {
    envMocks.REASONING_PROVIDER = "gemini";
    geminiMocks.isConfigured = false;

    await expect(ReasoningService.run(def(), input)).rejects.toSatisfy(
      (error) => {
        return (
          isAgentelseError(error) &&
          error.code === "PROVIDER_UNAVAILABLE" &&
          error.message.includes("GEMINI_API_KEY")
        );
      },
    );
    expect(geminiMocks.runStructured).not.toHaveBeenCalled();
  });
});
