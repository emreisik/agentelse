import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentelseError } from "@/server/security/errors";

// The plan allowance around the real embeddings call (docs/billing-tasks.md): the
// client is asked once, before the daily counter; running out looks exactly like
// the daily budget running out to the caller; the offline mock mode is free.

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  check: vi.fn(),
  record: vi.fn(),
  mock: vi.fn(),
  gate: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    embeddings = { create: mocks.create };
  },
}));
vi.mock("@/lib/env", () => ({
  getEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
}));
vi.mock("@/server/repositories/autonomy-policy.repository", () => ({
  AutonomyPolicyRepository: { checkAndIncrement: mocks.check },
}));
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: mocks.record },
}));
vi.mock("@/server/integrations/search-console/search-analytics", () => ({
  gscMockMode: mocks.mock,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/server/billing/call-gate", () => ({ gatedAiCall: mocks.gate }));

const { embedTexts } = await import("./embeddings");

const SCOPE = { workspaceId: "w1", projectId: "p1", brandId: "b1" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENTELSE_REASONING_MODE;
  mocks.mock.mockReturnValue(false);
  mocks.check.mockResolvedValue(undefined);
  mocks.record.mockResolvedValue({ id: "rc" });
  mocks.create.mockResolvedValue({
    data: [{ index: 0, embedding: new Array(256).fill(0.1) }],
    usage: { total_tokens: 12 },
  });
  mocks.gate.mockImplementation(
    async (_input: unknown, run: () => Promise<unknown>) => run(),
  );
});

describe("embedTexts plan allowance", () => {
  it("asks the gate for the SEO module with a small positive hold", async () => {
    await embedTexts(["red shoes"], SCOPE);
    expect(mocks.gate).toHaveBeenCalledTimes(1);
    const [input] = mocks.gate.mock.calls[0]! as [
      { module: string; source: string; purpose: string; estimateMicros: () => bigint },
    ];
    expect(input).toMatchObject({
      module: "SEO",
      source: "embeddings",
      purpose: "seo.embed",
    });
    const hold = input.estimateMicros();
    expect(hold).toBeGreaterThan(BigInt(0));
    // Embeddings are cheap: the hold stays tiny even for a full batch.
    expect(hold).toBeLessThan(BigInt(50_000));
  });

  it("reports an exhausted allowance as the daily budget being hit, and calls nothing", async () => {
    mocks.gate.mockRejectedValue(
      new AgentelseError("BUDGET_EXCEEDED", "used up", {
        meta: { limit: "planAllowance" },
      }),
    );
    const result = await embedTexts(["red shoes"], SCOPE);
    expect(result).toEqual({ vectors: null, budgetHit: true });
    expect(mocks.create).not.toHaveBeenCalled();
    // The refused call did not use up the day's call count.
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("does not hide a failure that is not a budget stop", async () => {
    mocks.gate.mockRejectedValue(new Error("ledger exploded"));
    await expect(embedTexts(["red shoes"], SCOPE)).rejects.toThrow(
      "ledger exploded",
    );
  });

  it("mock mode (offline vectors) never reaches the gate", async () => {
    mocks.mock.mockReturnValue(true);
    const result = await embedTexts(["red shoes"], SCOPE);
    expect(result.vectors).toHaveLength(1);
    expect(mocks.gate).not.toHaveBeenCalled();
  });
});
