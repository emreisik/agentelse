import { randomUUID } from "node:crypto";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
import { getUsageScope, runAsBackground } from "./usage-context";

// The plan-allowance gate around a single engine call, against a real Postgres.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_gate_${runId}_${++counter}`;

// The paid window comes from the clock, never from a written date: a fixed end
// date is one day in the past, every workspace below would then read as "no plan"
// and this suite would fail for no reason. It starts with the current month and
// runs about 13 months on.
const DAY_MS = 24 * 60 * 60 * 1000;
const today = new Date();
const WINDOW_START = new Date(
  Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
);
const WINDOW_END = new Date(WINDOW_START.getTime() + 400 * DAY_MS);

// call-gate.ts remembers a refused workspace for this long (REFUSAL_TTL_MS).
const REFUSAL_TTL_MS = 30_000;

// An active plan whose period allowance is `micros` for the workspace (Growth: a
// full plan, the system's own work may use 70% of it), `used` of it already spent.
async function grantPlan(ws: string, micros: number, used = 0) {
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
      periodUsed: B(used),
      updatedAt: new Date(),
    },
  });
}

async function workspace(micros: number | null, used = 0) {
  const ws = newWs();
  if (micros !== null) await grantPlan(ws, micros, used); // null: no plan
  return ws;
}

// Allowance that arrives later (a purchased add-on).
const topUp = (workspaceId: string, micros: number) =>
  prisma.usageBalance.update({
    where: { workspaceId_unit: { workspaceId, unit: "AI_MICROS" } },
    data: { extraGranted: B(micros) },
  });

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
    vi.useRealTimers();
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

  // Only the clock is faked in the next tests: the database connection keeps its
  // real timers.
  it("forgets a refusal after 30 seconds: a customer who topped up is served again, and not before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const ws = await workspace(10_000);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "no"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    // Money arrives. The refusal is still fresh, so the same call is turned away
    // without the ledger being asked ...
    await topUp(ws, 500_000);
    vi.setSystemTime(t0 + REFUSAL_TTL_MS - 1_000);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "no"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await balanceOf(ws)).toEqual({ used: 0, reserved: 0 });

    // ... but once the 30 seconds are over the same call reaches the ledger
    // again, and now it fits.
    vi.setSystemTime(t0 + REFUSAL_TTL_MS + 1_000);
    await expect(
      gatedAiCall(call(ws, 60_000), spend(1_000)),
    ).resolves.toBe("done");
    expect(await balanceOf(ws)).toEqual({ used: 1_000, reserved: 0 });
  });

  it("remembers a workspace without a plan as refused for ANY amount, until the 30 seconds are over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const ws = await workspace(null);
    await expect(
      gatedAiCall(call(ws, 60_000), async () => "no"),
    ).rejects.toMatchObject({ meta: { limit: "noPlan" } });

    // The customer subscribes. Inside the 30 seconds even a call far smaller than
    // the refused one is turned away (a missing plan refuses every amount, unlike
    // a balance that is merely too small) ...
    await grantPlan(ws, 3_000_000);
    vi.setSystemTime(t0 + REFUSAL_TTL_MS - 1_000);
    const smaller = vi.fn(async () => "never");
    await expect(gatedAiCall(call(ws, 1), smaller)).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      meta: { limit: "noPlan" },
    });
    expect(smaller).not.toHaveBeenCalled();

    // ... and afterwards the ledger is asked again.
    vi.setSystemTime(t0 + REFUSAL_TTL_MS + 1_000);
    await expect(gatedAiCall(call(ws, 1), spend(1))).resolves.toBe("done");
  });

  it("remembers a refusal per workspace: another customer is not turned away because of it", async () => {
    const short = await workspace(10_000);
    const funded = await workspace(3_000_000);
    await expect(
      gatedAiCall(call(short, 60_000), async () => "no"),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

    await expect(
      gatedAiCall(call(funded, 60_000), spend(1_000)),
    ).resolves.toBe("done");
  });

  describe("who asked decides who is turned away (the system's share, Faz 3C)", () => {
    // Growth: of 10M, the system may use 7M; 3M stay for the user.
    const system = <T>(run: () => Promise<T>) => runAsBackground(run);

    it("a refusal of the system's call does not turn the user's identical call away", async () => {
      const ws = await workspace(10_000_000, 5_000_000);

      // 5M left, 3M of them the user's: the system's 3M call does not fit ...
      await expect(
        system(() => gatedAiCall(call(ws, 3_000_000), async () => "no")),
      ).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        meta: { limit: "planAllowance" },
      });
      // ... and the user, right after, is asked of the ledger and fits.
      await expect(
        gatedAiCall(call(ws, 3_000_000), spend(1_000)),
      ).resolves.toBe("done");
      expect(await balanceOf(ws)).toEqual({ used: 5_001_000, reserved: 0 });
    });

    it("remembers the system's refusal for the system only", async () => {
      const ws = await workspace(10_000_000, 5_000_000);
      await expect(
        system(() => gatedAiCall(call(ws, 3_000_000), async () => "no")),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

      // Money arrives: the system would fit now, but its refusal is still fresh ...
      await topUp(ws, 5_000_000);
      const fn = vi.fn(async () => "never");
      await expect(
        system(() => gatedAiCall(call(ws, 3_000_000), fn)),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(fn).not.toHaveBeenCalled();
      // ... while the user is untouched by it.
      await expect(
        gatedAiCall(call(ws, 3_000_000), spend(1_000)),
      ).resolves.toBe("done");
    });

    it("a smaller call of the system is not lowered to the refused one: the user is never asked about it", async () => {
      const ws = await workspace(10_000_000, 5_000_000);
      // A tiny system call fits above the user's 3M (2M of room): not refused.
      await expect(
        system(() => gatedAiCall(call(ws, 1_000_000), spend(1_000))),
      ).resolves.toBe("done");
      // The bigger one is refused, and that leaves the user's 4M call alone.
      await expect(
        system(() => gatedAiCall(call(ws, 2_500_000), async () => "no")),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      await expect(
        gatedAiCall(call(ws, 4_000_000), spend(1_000)),
      ).resolves.toBe("done");
    });

    it("a refusal of the user's call turns the system away too: the allowance is really used up", async () => {
      const ws = await workspace(10_000_000, 9_000_000);
      await expect(
        gatedAiCall(call(ws, 2_000_000), async () => "no"),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

      // Money arrives (the ledger would take the system's call now); the user's
      // refusal is still fresh, and a system call of that size or more is turned away.
      await topUp(ws, 8_000_000);
      const fn = vi.fn(async () => "never");
      await expect(
        system(() => gatedAiCall(call(ws, 2_000_000), fn)),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(fn).not.toHaveBeenCalled();
      expect(await balanceOf(ws)).toEqual({ used: 9_000_000, reserved: 0 });
    });

    it("a missing plan is refused for everyone, whoever asked first", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      const ws = await workspace(null);
      await expect(
        system(() => gatedAiCall(call(ws, 60_000), async () => "no")),
      ).rejects.toMatchObject({ meta: { limit: "noPlan" } });

      await grantPlan(ws, 3_000_000);
      vi.setSystemTime(t0 + REFUSAL_TTL_MS - 1_000);
      await expect(
        gatedAiCall(call(ws, 1), async () => "never"),
      ).rejects.toMatchObject({ meta: { limit: "noPlan" } });

      vi.setSystemTime(t0 + REFUSAL_TTL_MS + 1_000);
      await expect(gatedAiCall(call(ws, 1), spend(1))).resolves.toBe("done");
    });
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
