import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { usageEntry: { create } } }));

// vitest.setup.ts replaces the recorder with a no-op everywhere; this suite
// tests the real one.
vi.unmock("@/server/billing/usage-recorder");

import { Prisma } from "@prisma/client";

import { runWithUsageScope } from "./usage-context";
import {
  recordUsage,
  UNATTRIBUTED_WORKSPACE,
  usdToMicros,
} from "./usage-recorder";

const base = {
  kind: "TEXT" as const,
  provider: "openai" as const,
  model: "gpt-5.6-luna",
  costUsd: 0.0123456,
  costEstimated: false,
  success: true,
  durationMs: 1200,
};

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({});
});

describe("usdToMicros", () => {
  it("rounds to whole micro-dollars and never goes negative", () => {
    expect(usdToMicros(0.0123456)).toBe(BigInt(12346));
    expect(usdToMicros(0)).toBe(BigInt(0));
    expect(usdToMicros(-1)).toBe(BigInt(0));
    expect(usdToMicros(Number.NaN)).toBe(BigInt(0));
  });
});

describe("recordUsage", () => {
  it("writes the ambient scope, derived module and price table stamp", async () => {
    await runWithUsageScope(
      {
        workspaceId: "w1",
        projectId: "p1",
        userId: "u1",
        source: "reasoning",
        purpose: "seo.article",
        operationId: "op1",
      },
      () => recordUsage({ ...base, inputTokens: 100, outputTokens: 50 }),
    );

    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      workspaceId: "w1",
      projectRef: "p1",
      userId: "u1",
      module: "SEO",
      source: "reasoning",
      operationId: "op1",
      purpose: "seo.article",
      kind: "TEXT",
      costMicros: BigInt(12346),
      costEstimated: false,
      success: true,
      inputTokens: 100,
    });
    expect(data.callId).toBeTruthy();
    expect(data.priceTable).toMatch(/^\d{4}-\d{2}$/);
    // The ledger must never use a column the brand-deletion service wipes.
    expect(data).not.toHaveProperty("projectId");
  });

  it("keeps a call with no scope instead of dropping it", async () => {
    await recordUsage(base);
    expect(create.mock.calls[0]![0].data).toMatchObject({
      workspaceId: UNATTRIBUTED_WORKSPACE,
      purpose: "unknown",
    });
  });

  it("lets an explicit scope override the ambient one", async () => {
    await runWithUsageScope({ workspaceId: "ambient" }, () =>
      recordUsage({
        ...base,
        scope: { workspaceId: "explicit", projectId: "p9" },
      }),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({
      workspaceId: "explicit",
      projectRef: "p9",
    });
  });

  it("treats a repeated callId as already recorded", async () => {
    create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    await expect(recordUsage({ ...base, callId: "c1" })).resolves.toBeUndefined();
  });

  it("never throws into the paid call when the write fails", async () => {
    create.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordUsage(base)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
