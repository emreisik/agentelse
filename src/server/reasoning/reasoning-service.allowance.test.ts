import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The plan-allowance gate around ReasoningService.run (docs/billing-tasks.md):
// where it sits, what it is told, and that a refusal costs nothing.

const gate = vi.hoisted(() => ({
  calls: [] as Array<{
    input: Record<string, unknown> & { estimateMicros: () => bigint };
  }>,
  refuse: undefined as Error | undefined,
}));
vi.mock("@/server/billing/call-gate", () => ({
  gatedAiCall: async (
    input: Record<string, unknown> & { estimateMicros: () => bigint },
    fn: () => Promise<unknown>,
  ) => {
    gate.calls.push({ input });
    if (gate.refuse) throw gate.refuse;
    return fn();
  },
}));

const openai = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/server/reasoning/openai-client", () => ({
  isOpenAIConfigured: () => true,
  openaiModelForTier: () => "gpt-5.6-luna",
  runOpenAIStructured: openai.run,
}));
vi.mock("@/server/reasoning/openai-search-client", () => ({
  runOpenAIStructuredWithSearch: openai.run,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { project: { findUnique: vi.fn().mockResolvedValue(null) } },
}));
const counters = vi.hoisted(() => ({ checkAndIncrement: vi.fn() }));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { checkAndIncrement: counters.checkAndIncrement },
}));
const callRepo = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: callRepo.record },
}));
vi.mock("@/server/repositories/audit-log.repository", () => ({
  AuditLogRepository: { record: vi.fn().mockResolvedValue(undefined) },
}));

import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AgentelseError } from "@/server/security/errors";
import type { ReasoningDef, ReasoningInput } from "@/server/reasoning/types";

const schema = z.object({ value: z.string() });
const def = (
  overrides: Partial<ReasoningDef<{ value: string }>> = {},
): ReasoningDef<{ value: string }> => ({
  purpose: "seo.explain",
  schema,
  buildPrompt: () => ({ system: "sys", user: "usr" }),
  buildMock: () => ({ value: "mocked" }),
  ...overrides,
});
const input: ReasoningInput = {
  workspaceId: "ws-1",
  projectId: "project-1",
  brandId: "brand-1",
  context: { topic: "coffee" },
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.calls = [];
  gate.refuse = undefined;
  vi.unstubAllEnvs();
  vi.stubEnv("AGENTELSE_REASONING_MODE", "auto");
  counters.checkAndIncrement.mockResolvedValue(undefined);
  callRepo.record.mockResolvedValue({ id: "call-1" });
  openai.run.mockResolvedValue({ raw: { value: "out" } });
});

describe("ReasoningService.run plan allowance", () => {
  it("asks the gate with the workspace, the purpose's module and a positive maximum", async () => {
    await ReasoningService.run(def(), input);

    expect(gate.calls).toHaveLength(1);
    const { input: asked } = gate.calls[0]!;
    expect(asked).toMatchObject({
      workspaceId: "ws-1",
      projectId: "project-1",
      module: "SEO",
      source: "reasoning",
      purpose: "seo.explain",
    });
    expect(asked.estimateMicros()).toBeGreaterThan(BigInt(0));
  });

  it("sizes the hold from the output budget, the context and the web searches", async () => {
    await ReasoningService.run(def({ maxTokens: 1_000 }), input);
    await ReasoningService.run(def({ maxTokens: 8_000 }), input);
    await ReasoningService.run(def({ maxTokens: 1_000, webSearch: true }), input);
    await ReasoningService.run(def({ maxTokens: 1_000 }), {
      ...input,
      context: { text: "x".repeat(60_000) },
    });
    const [small, large, search, bigContext] = gate.calls.map((call) =>
      call.input.estimateMicros(),
    );
    expect(large! > small!).toBe(true);
    expect(search! > small!).toBe(true);
    expect(bigContext! > small!).toBe(true);
  });

  it("a refused call touches nothing else: no daily counter and no model", async () => {
    gate.refuse = new AgentelseError("BUDGET_EXCEEDED", "used up", {
      meta: { limit: "planAllowance" },
    });
    await expect(ReasoningService.run(def(), input)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
    });
    expect(counters.checkAndIncrement).not.toHaveBeenCalled();
    expect(openai.run).not.toHaveBeenCalled();
  });

  // The sweeping engines (insight synthesis, idea refill) throttle themselves on
  // the last ReasoningCall of a project. A refusal that leaves no row makes them
  // pick the same stalled client again on every tick.
  it("leaves one BLOCKED row for a refusal, throttled, so sweeping engines back off", async () => {
    gate.refuse = new AgentelseError("BUDGET_EXCEEDED", "used up", {
      meta: { limit: "planAllowance" },
    });
    const other = { ...input, projectId: "project-blocked-1" };
    await expect(ReasoningService.run(def(), other)).rejects.toThrow();
    await expect(ReasoningService.run(def(), other)).rejects.toThrow();
    await expect(ReasoningService.run(def(), other)).rejects.toThrow();

    // Once, not three times; and not an error row (System Health reads those).
    expect(callRepo.record).toHaveBeenCalledTimes(1);
    expect(callRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-blocked-1",
        purpose: "seo.explain",
        status: "BLOCKED",
        isMock: false,
      }),
    );
  });

  it("a refusal for another reason (the project's own daily cap) writes no such row", async () => {
    gate.refuse = new AgentelseError("BUDGET_EXCEEDED", "cap", {
      meta: { limit: "dailyBudgetUsd" },
    });
    await expect(
      ReasoningService.run(def(), { ...input, projectId: "project-daily" }),
    ).rejects.toThrow();
    expect(callRepo.record).not.toHaveBeenCalled();
  });

  it("an allowed call then goes through the same steps as before", async () => {
    const result = await ReasoningService.run(def(), input);
    expect(result.output).toEqual({ value: "out" });
    expect(counters.checkAndIncrement).toHaveBeenCalled();
    expect(openai.run).toHaveBeenCalledTimes(1);
  });

  it("mock mode (tests, seeds) never reaches the gate", async () => {
    vi.stubEnv("AGENTELSE_REASONING_MODE", "mock");
    const result = await ReasoningService.run(def(), input);
    expect(result.isMock).toBe(true);
    expect(gate.calls).toHaveLength(0);
  });
});
