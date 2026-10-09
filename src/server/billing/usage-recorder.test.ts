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
import { UsageMeter } from "./usage-meter";

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

describe("recordUsage -> operation meter", () => {
  const meterFor = (workspaceId: string) =>
    new UsageMeter({ workspaceId, operationId: "op" });

  it("adds every paid call of the ambient operation to its meter", async () => {
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, async () => {
      await recordUsage({ ...base, costUsd: 0.01 });
      await recordUsage({ ...base, kind: "IMAGE", costUsd: 0.08, units: 1 });
    });
    expect(meter.costMicros).toBe(BigInt(90_000));
    expect(meter.images).toBe(1);
    expect(meter.calls).toBe(2);
  });

  it("counts a failed call's cost but not its picture", async () => {
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, () =>
      recordUsage({ ...base, kind: "IMAGE", costUsd: 0.02, success: false }),
    );
    expect(meter.costMicros).toBe(BigInt(20_000));
    expect(meter.images).toBe(0);
  });

  it("still adds to the meter when the UsageEntry write fails", async () => {
    create.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, () =>
      recordUsage({ ...base, costUsd: 0.5 }),
    );
    expect(meter.costMicros).toBe(BigInt(500_000));
    spy.mockRestore();
  });

  it("does not double-count a repeated callId", async () => {
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, async () => {
      await recordUsage({ ...base, callId: "c1", costUsd: 0.1 });
      await recordUsage({ ...base, callId: "c1", costUsd: 0.1 });
    });
    expect(meter.costMicros).toBe(BigInt(100_000));
  });

  it("never feeds another workspace's meter", async () => {
    const meter = meterFor("w1");
    // Explicit scope names a different workspace than the meter's owner.
    await runWithUsageScope({ workspaceId: "w1", meter }, () =>
      recordUsage({
        ...base,
        costUsd: 0.3,
        scope: { workspaceId: "w2", meter },
      }),
    );
    expect(meter.costMicros).toBe(BigInt(0));
  });

  it("drops an inherited meter when a nested scope moves to another workspace", async () => {
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, () =>
      runWithUsageScope({ workspaceId: "w2" }, () =>
        recordUsage({ ...base, costUsd: 0.3 }),
      ),
    );
    expect(meter.costMicros).toBe(BigInt(0));
  });

  it("lets a nested scope of the same workspace keep feeding the meter", async () => {
    const meter = meterFor("w1");
    await runWithUsageScope({ workspaceId: "w1", meter }, () =>
      runWithUsageScope({ workspaceId: "w1", purpose: "inner" }, () =>
        recordUsage({ ...base, costUsd: 0.3 }),
      ),
    );
    expect(meter.costMicros).toBe(BigInt(300_000));
  });
});
