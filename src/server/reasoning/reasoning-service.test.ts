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

const searchMocks = vi.hoisted(() => ({ runStructured: vi.fn() }));
vi.mock("@/server/reasoning/openai-search-client", () => ({
  runOpenAIStructuredWithSearch: searchMocks.runStructured,
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
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { ReasoningCallRepository } from "@/server/repositories/reasoning-call.repository";
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

describe("ReasoningService.run with web search", () => {
  const lastRecordedCall = () =>
    vi.mocked(ReasoningCallRepository.record).mock.calls.at(-1)![0];
  const lastAudit = () =>
    vi.mocked(AuditLogRepository.record).mock.calls.at(-1)![0];

  beforeEach(() => {
    vi.clearAllMocks();
    envMocks.REASONING_PROVIDER = "openai";
    openaiMocks.isConfigured = true;
    geminiMocks.isConfigured = true;
    openaiMocks.runStructured.mockResolvedValue({ raw: { value: "plain-out" } });
    geminiMocks.runStructured.mockResolvedValue({ raw: { value: "gemini-out" } });
    searchMocks.runStructured.mockResolvedValue({
      raw: { value: "search-out" },
      inputTokens: 1_000,
      outputTokens: 500,
      webSearchCalls: 3,
    });
  });

  afterEach(() => {
    delete process.env.AGENTELSE_REASONING_MODE;
  });

  it("sends a def that asks for web search to the search-enabled client", async () => {
    const result = await ReasoningService.run(def({ webSearch: true }), input);

    expect(result.output).toEqual({ value: "search-out" });
    expect(searchMocks.runStructured).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.6-luna" }),
    );
    expect(openaiMocks.runStructured).not.toHaveBeenCalled();
  });

  it("does not search unless the def asks for it", async () => {
    const result = await ReasoningService.run(def(), input);

    expect(result.output).toEqual({ value: "plain-out" });
    expect(searchMocks.runStructured).not.toHaveBeenCalled();
  });

  it("bills every search on top of the tokens", async () => {
    await ReasoningService.run(def({ webSearch: true }), input);

    // gpt-5.6-luna: 1000 in x $1/M + 500 out x $6/M = $0.004, plus 3 x $0.01.
    expect(lastRecordedCall().costUsd).toBeCloseTo(0.034, 6);
  });

  it("puts the number of searches in the audit trail, and only when there were any", async () => {
    await ReasoningService.run(def({ webSearch: true }), input);
    expect(lastAudit().metadata).toEqual({
      isMock: false,
      model: "gpt-5.6-luna",
      webSearchCalls: 3,
    });

    searchMocks.runStructured.mockResolvedValue({
      raw: { value: "search-out" },
      inputTokens: 10,
      outputTokens: 10,
      webSearchCalls: 0,
    });
    await ReasoningService.run(def({ webSearch: true }), input);
    expect(lastAudit().metadata).toEqual({
      isMock: false,
      model: "gpt-5.6-luna",
    });
  });

  it("ignores the request on a backend that cannot search instead of failing", async () => {
    envMocks.REASONING_PROVIDER = "gemini";

    const result = await ReasoningService.run(def({ webSearch: true }), input);

    expect(result.output).toEqual({ value: "gemini-out" });
    expect(searchMocks.runStructured).not.toHaveBeenCalled();
  });

  it("never calls the search client in mock mode: the def's own mock stands in", async () => {
    process.env.AGENTELSE_REASONING_MODE = "mock";

    const result = await ReasoningService.run(def({ webSearch: true }), input);

    expect(result).toMatchObject({ output: { value: "mocked" }, isMock: true });
    expect(searchMocks.runStructured).not.toHaveBeenCalled();
  });
});
