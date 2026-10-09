import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";
import { describeIntegration } from "@/test-support/integration-suite";

import { gatedAiCall, resetCallGate } from "./call-gate";
import { beginOperation } from "./operation";
import { getUsageScope } from "./usage-context";

// The plan-allowance gate around a single engine call, against a real Postgres.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_gate_${runId}_${++counter}`;
const WINDOW_START = new Date("2026-10-01T00:00:00.000Z");
const WINDOW_END = new Date("2027-12-01T00:00:00.000Z");

async function workspace(micros: number | null) {
  const ws = newWs();
  if (micros === null) return ws; // no plan
  await prisma.subscription.create({
    data: {
      workspaceId: ws,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: WINDOW_END,
    },
  });
  await prisma.usageBalance.create({
    data: {
      id: randomUUID(),
      workspaceId: ws,
      unit: "AI_MICROS",
      periodStart: WINDOW_START,
      periodEnd: WINDOW_END,
      periodGranted: B(micros),
      updatedAt: new Date(),
    },
  });
  return ws;
}

const balanceOf = async (workspaceId: string) => {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit: "AI_MICROS" } },
  });
  return { used: Number(row.periodUsed), reserved: Number(row.periodReserved) };
};

const call = (workspaceId: string, estimate: number) => ({
  workspaceId,
  projectId: "p",
  module: "SEO" as const,
  source: "reasoning",
  purpose: "seo.explain",
  estimateMicros: () => B(estimate),
});

const spend = (micros: number) => async () => {
  getUsageScope()?.meter?.add({
    callId: randomUUID(),
    kind: "TEXT",
    costMicros: B(micros),
    success: true,
  });
  return "done";
};

describeIntegration("plan allowance gate for one engine call", () => {
  beforeEach(() => resetCallGate());
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });
  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_gate_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
  });

  it("holds the maximum, runs the call, charges what it actually cost", async () => {
    const ws = await workspace(3_000_000);
    let heldDuring = -1;
    const result = await gatedAiCall(call(ws, 60_000), async () => {
      heldDuring = (await balanceOf(ws)).reserved;
      return spend(22_000)();
    });
    expect(result).toBe("done");
    expect(heldDuring).toBe(60_000);
    expect(await balanceOf(ws)).toEqual({ used: 22_000, reserved: 0 });
  });

  it("refuses with the budget stop engine code already understands, without running the call", async () => {
    const ws = await workspace(10_000);
    const fn = vi.fn(async () => "never");
    const error = await gatedAiCall(call(ws, 60_000), fn).catch((e: unknown) => e);
    expect(fn).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(AgentelseError);
    expect(error).toMatchObject({
      code: "BUDGET_EXCEEDED",
      meta: { limit: "planAllowance", unit: "AI_MICROS", available: 10_000 },
    });
    expect(await balanceOf(ws)).toEqual({ used: 0, reserved: 0 });
  });

  it("a workspace without a plan is stopped the same way, as noPlan", async () => {
    const ws = await workspace(null);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "never"),
    ).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      meta: { limit: "noPlan" },
    });
  });

  it("remembers a refusal for a moment, so a stalled tenant is not asked of the ledger again and again", async () => {
    const ws = await workspace(10_000);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "no"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    // Money arrives, but the refusal is still fresh for an equal or larger call ...
    await prisma.usageBalance.update({
      where: { workspaceId_unit: { workspaceId: ws, unit: "AI_MICROS" } },
      data: { extraGranted: B(500_000) },
    });
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "no"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    // ... while a smaller one is tried for real and fits.
    await expect(
      gatedAiCall(call(ws, 5_000), spend(1_000)),
    ).resolves.toBe("done");

    resetCallGate();
    await expect(
      gatedAiCall(call(ws, 60_000), spend(1_000)),
    ).resolves.toBe("done");
  });

  it("joins the reservation of the job it runs inside instead of asking for its own", async () => {
    const ws = await workspace(3_000_000);
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId: ws,
        unit: "IMAGE",
        periodStart: WINDOW_START,
        periodEnd: WINDOW_END,
        periodGranted: B(5),
        updatedAt: new Date(),
      },
    });
    const job = await beginOperation({
      workspaceId: ws,
      operationId: `exec:${randomUUID()}`,
      attemptToken: "e.1",
      reserve: { IMAGE: 1 },
    });
    const estimate = vi.fn(() => B(60_000));
    await job.run(() =>
      gatedAiCall({ ...call(ws, 0), estimateMicros: estimate }, spend(9_000)),
    );
    // No reservation of its own and no estimate computed.
    expect(estimate).not.toHaveBeenCalled();
    expect((await balanceOf(ws)).reserved).toBe(0);
    // Its cost rides on the job's meter.
    expect(job.meter.costMicros).toBe(B(9_000));
    await job.finish("aborted");
  });

  it("does NOT join a free operation: an AI call inside it pays for itself", async () => {
    const ws = await workspace(3_000_000);
    const free = await beginOperation({
      workspaceId: ws,
      operationId: `exec:${randomUUID()}`,
      attemptToken: "e.1",
      reserve: {},
    });
    await free.run(() => gatedAiCall(call(ws, 60_000), spend(9_000)));
    expect(await balanceOf(ws)).toEqual({ used: 9_000, reserved: 0 });
    await free.finish("delivered");
  });

  it("gives the hold back when the call itself refuses (the project's own daily cap)", async () => {
    const ws = await workspace(3_000_000);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => {
        throw new AgentelseError("BUDGET_EXCEEDED", "daily cap", {
          meta: { limit: "dailyBudgetUsd" },
        });
      }),
    ).rejects.toMatchObject({ meta: { limit: "dailyBudgetUsd" } });
    expect(await balanceOf(ws)).toEqual({ used: 0, reserved: 0 });
  });

  it("a failure that cost real money is still charged, up to the hold", async () => {
    const ws = await workspace(3_000_000);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => {
        await spend(500_000)();
        throw new Error("unusable output");
      }),
    ).rejects.toThrow("unusable output");
    expect(await balanceOf(ws)).toEqual({ used: 60_000, reserved: 0 });
  });

  it("off: just runs the call (no estimate, no ledger)", async () => {
    config.current = { ...config.current, mode: "off" };
    const ws = await workspace(null);
    const estimate = vi.fn(() => B(60_000));
    const result = await gatedAiCall(
      { ...call(ws, 0), estimateMicros: estimate },
      async () => "ok",
    );
    expect(result).toBe("ok");
    expect(estimate).not.toHaveBeenCalled();
  });

  it("shadow: never refuses", async () => {
    config.current = { ...config.current, mode: "shadow" };
    const ws = await workspace(1_000);
    await expect(
      gatedAiCall(call(ws, 60_000), spend(2_000)),
    ).resolves.toBe("done");
  });
});
