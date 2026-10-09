import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Faturalama ayarı test başına belirlenir (env önbelleğine bağımlı değil).
const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

import { prisma } from "@/lib/prisma";
import { describeIntegration } from "@/test-support/integration-suite";

import {
  beginOperation,
  releaseOperationReservations,
  runMetered,
  type OperationSpec,
} from "./operation";
import { NoPlanError, QuotaExceededError } from "./quota-errors";
import { resetShadowLogThrottle } from "./shadow-log";
import { getUsageScope } from "./usage-context";

// Operasyon yaşam döngüsü (rezerve → çalış → mahsup/iade) GERÇEK Postgres'e karşı.
// Tek kullanımlık yerel/CI veritabanı; paylaşılan Neon'a asla.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_op_${runId}_${++counter}`;

const NOW = new Date("2026-11-15T12:00:00.000Z");
const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-12-01T00:00:00.000Z");

type Unit = "IMAGE" | "AI_MICROS";

async function activeSubscription(workspaceId: string) {
  await prisma.subscription.create({
    data: {
      workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: WINDOW_END,
    },
  });
}

async function seedBalance(
  workspaceId: string,
  unit: Unit,
  values: { periodGranted: number; periodUsed?: number },
) {
  await prisma.usageBalance.create({
    data: {
      id: randomUUID(),
      workspaceId,
      unit,
      periodStart: WINDOW_START,
      periodEnd: WINDOW_END,
      periodGranted: B(values.periodGranted),
      periodUsed: B(values.periodUsed ?? 0),
      updatedAt: NOW,
    },
  });
}

// Geçerli planı ve iki birimde bakiyesi olan bir workspace.
async function fundedWorkspace(images: number, micros: number) {
  const ws = newWs();
  await activeSubscription(ws);
  await seedBalance(ws, "IMAGE", { periodGranted: images });
  await seedBalance(ws, "AI_MICROS", { periodGranted: micros });
  return ws;
}

async function balanceOf(workspaceId: string, unit: Unit) {
  const row = await prisma.usageBalance.findUniqueOrThrow({
    where: { workspaceId_unit: { workspaceId, unit } },
  });
  return {
    used: Number(row.periodUsed),
    reserved: Number(row.periodReserved),
  };
}

const reservationsOf = (workspaceId: string, unit?: Unit) =>
  prisma.usageReservation.findMany({
    where: { workspaceId, ...(unit ? { unit } : {}) },
    orderBy: { createdAt: "asc" },
  });

let attempt = 0;
function spec(
  workspaceId: string,
  reserve: OperationSpec["reserve"],
  overrides: Partial<OperationSpec> = {},
): OperationSpec {
  return {
    workspaceId,
    operationId: `exec:${randomUUID()}`,
    attemptToken: `evt.${++attempt}`,
    reserve,
    now: NOW,
    ...overrides,
  };
}

function drawn(op: Awaited<ReturnType<typeof beginOperation>>, images = 1) {
  op.meter.add({
    callId: randomUUID(),
    kind: "IMAGE",
    costMicros: B(80_000),
    success: true,
    units: images,
  });
}

function spent(op: Awaited<ReturnType<typeof beginOperation>>, micros: number) {
  op.meter.add({
    callId: randomUUID(),
    kind: "TEXT",
    costMicros: B(micros),
    success: true,
  });
}

describeIntegration("billing operation lifecycle", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    resetShadowLogThrottle();
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_op_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
  });

  describe("content operation (image rights)", () => {
    it("holds the rights up front and settles the pictures actually drawn", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 2 }));
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 2 });
      drawn(op, 1);
      await op.finish("delivered");
      // 2 held, 1 drawn: 1 charged, the other handed back.
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
      // Costs inside a content operation never touch the AI budget.
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("hands the rights back when the job failed or never ran, even if a picture was drawn", async () => {
      for (const outcome of ["failed", "aborted"] as const) {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));
        drawn(op, 1);
        await op.finish(outcome);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
      }
    });

    it("never charges more pictures than it reserved (a re-render must not cost two rights for one post)", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 1 }));
      drawn(op, 1);
      drawn(op, 1); // the first render was stored badly, the retry rendered again
      await op.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
    });

    it("leaves the reservation open while the result is still undecided", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 1 }));
      drawn(op, 1);
      await op.finish("pending");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 1 });
    });

    it("charges the text work to the AI budget when the job delivered no picture", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 1 }));
      spent(op, 20_000); // text step ran, the image model refused the brief
      await op.finish("delivered");
      // No picture, no image right ...
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
      // ... but the text it paid for is not free.
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 20_000,
        reserved: 0,
      });
    });

    it("caps that text charge and skips it silently when there is no AI budget left", async () => {
      const capped = await fundedWorkspace(5, 3_000_000);
      const a = await beginOperation(spec(capped, { IMAGE: 1 }));
      spent(a, 400_000);
      await a.finish("delivered");
      expect((await balanceOf(capped, "AI_MICROS")).used).toBe(100_000);

      const broke = await fundedWorkspace(5, 0);
      const b = await beginOperation(spec(broke, { IMAGE: 1 }));
      spent(b, 20_000);
      await expect(b.finish("delivered")).resolves.toBeUndefined();
      expect(await balanceOf(broke, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("finish is idempotent: a second call never charges again", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 1 }));
      drawn(op, 1);
      await Promise.all([op.finish("delivered"), op.finish("delivered")]);
      await op.finish("aborted");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
    });
  });

  describe("ai operation (other-AI budget)", () => {
    it("still charges a billed failure, up to the reservation", async () => {
      // The model bills for a long answer, then the result is unusable: the job
      // fails. Refunding all of it would make failing on purpose a free ride.
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));
      spent(op, 400_000);
      await op.finish("failed");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 90_000,
        reserved: 0,
      });
    });

    it("refunds a failure that cost nothing (provider down, rate limit)", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));
      await op.finish("failed");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({ used: 0, reserved: 0 });
    });

    it("refunds in full when the outcome is unknown (an error nobody can attribute)", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));
      spent(op, 40_000);
      await op.finish("aborted");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({ used: 0, reserved: 0 });
    });

    it("settles the metered cost, not the estimate", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 90_000,
      });
      spent(op, 31_000);
      spent(op, 4_000);
      await op.finish("delivered");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 35_000,
        reserved: 0,
      });
    });

    it("books an overrun instead of losing it", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(10_000) }));
      spent(op, 25_000);
      await op.finish("delivered");
      const balance = await balanceOf(ws, "AI_MICROS");
      expect(balance.used).toBe(25_000);
      expect(balance.reserved).toBe(0);
    });
  });

  describe("not enough allowance", () => {
    it("refuses with the unit, the shortfall and the renewal date", async () => {
      const ws = await fundedWorkspace(1, 3_000_000);
      await expect(
        beginOperation(spec(ws, { IMAGE: 2 })),
      ).rejects.toMatchObject({
        code: "QUOTA_EXCEEDED",
        detail: {
          unit: "IMAGE",
          needed: 2,
          available: 1,
          resetsAt: WINDOW_END,
        },
      });
      // A refusal leaves no reservation behind.
      expect(await reservationsOf(ws)).toHaveLength(0);
    });

    it("gives the first unit back when the second does not fit", async () => {
      const ws = await fundedWorkspace(5, 50_000);
      const error = await beginOperation(
        spec(ws, { IMAGE: 1, AI_MICROS: B(90_000) }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect((error as QuotaExceededError).detail.unit).toBe("AI_MICROS");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
    });

    it("lets exactly the affordable operations through when many start together", async () => {
      const ws = await fundedWorkspace(7, 3_000_000);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          beginOperation(spec(ws, { IMAGE: 1 })),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r) => r.status === "rejected");
      expect(ok).toHaveLength(7);
      expect(refused).toHaveLength(13);
      for (const result of refused) {
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(
          QuotaExceededError,
        );
      }
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 7 });
    });
  });

  describe("no plan", () => {
    it("refuses a workspace without a plan", async () => {
      const ws = newWs();
      await expect(
        beginOperation(spec(ws, { IMAGE: 1 })),
      ).rejects.toBeInstanceOf(NoPlanError);
    });

    it("also refuses an operation that reserves nothing but asks for a plan", async () => {
      const ws = newWs();
      await expect(
        beginOperation(spec(ws, {}, { requireAccess: true })),
      ).rejects.toBeInstanceOf(NoPlanError);
    });

    it("lets an operation that reserves nothing run on a valid plan", async () => {
      const ws = await fundedWorkspace(0, 0);
      const op = await beginOperation(spec(ws, {}, { requireAccess: true }));
      expect(op.holdsReservation).toBe(false);
      await op.finish("delivered");
      expect(await reservationsOf(ws)).toHaveLength(0);
    });

    it("does not look at the plan at all unless asked (free work: publishing, ad writes)", async () => {
      const ws = newWs();
      const op = await beginOperation(spec(ws, {}));
      await op.finish("delivered");
      expect(
        await prisma.subscription.count({ where: { workspaceId: ws } }),
      ).toBe(0);
    });
  });

  describe("modes", () => {
    it("off: touches nothing and never refuses", async () => {
      config.current = { ...config.current, mode: "off" };
      const ws = newWs(); // no plan, no balance
      const op = await beginOperation(spec(ws, { IMAGE: 99 }));
      expect(op.holdsReservation).toBe(false);
      drawn(op, 3);
      await op.finish("delivered");
      expect(await reservationsOf(ws)).toHaveLength(0);
      expect(
        await prisma.usageBalance.count({ where: { workspaceId: ws } }),
      ).toBe(0);
    });

    it("shadow: never refuses, records what would have been refused", async () => {
      config.current = { ...config.current, mode: "shadow" };
      const ws = await fundedWorkspace(1, 3_000_000);
      const first = await beginOperation(spec(ws, { IMAGE: 1 }));
      const second = await beginOperation(spec(ws, { IMAGE: 1 })); // would be refused
      drawn(first, 1);
      drawn(second, 1);
      await first.finish("delivered");
      await second.finish("delivered");
      const noPlan = await beginOperation(spec(newWs(), { IMAGE: 1 }));
      await noPlan.finish("delivered");
      const decisions = await prisma.auditLog.findMany({
        where: { workspaceId: ws, action: { startsWith: "billing.shadow." } },
      });
      expect(decisions.map((row) => row.action)).toContain(
        "billing.shadow.insufficient",
      );
    });
  });

  describe("redelivery and re-runs", () => {
    it("adopts a reservation a crashed attempt left behind (same token) and settles it", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const base = spec(ws, { IMAGE: 1 });
      const crashed = await beginOperation(base); // never finished
      expect(crashed.holdsReservation).toBe(true);

      const retry = await beginOperation({ ...base }); // same operation + token
      expect(await reservationsOf(ws, "IMAGE")).toHaveLength(1);
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 1 });

      drawn(retry, 1);
      await retry.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
    });

    it("a run that gives up after adopting does not free the hold of the run that kept going", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const base = spec(ws, { IMAGE: 1 });
      const survivor = await beginOperation(base);
      const loser = await beginOperation({ ...base }); // lost the claim race
      await loser.abandon();
      // The survivor is still covered ...
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 1 });
      // ... and settles it when it finishes.
      drawn(survivor, 1);
      await survivor.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
    });

    it("abandon frees only what this call itself reserved", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { IMAGE: 1 }));
      await op.abandon();
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
      // A later finish after abandon changes nothing.
      drawn(op, 1);
      await op.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
    });

    it("pays again when the same token is run a second time after it was settled", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const base = spec(ws, { IMAGE: 1 });
      const first = await beginOperation(base);
      drawn(first, 1);
      await first.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });

      // e.g. a failed-then-retried job that reuses the outbox event's token
      const second = await beginOperation({ ...base });
      expect(second.holdsReservation).toBe(true);
      drawn(second, 1);
      await second.finish("delivered");
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 2, reserved: 0 });
    });
  });

  describe("scope and metering", () => {
    it("runs the work inside a scope that carries the operation's meter", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(
        spec(ws, { IMAGE: 1 }, { source: "test" }),
      );
      const seen = op.run(() => getUsageScope());
      expect(seen?.meter).toBe(op.meter);
      expect(seen?.workspaceId).toBe(ws);
      expect(seen?.source).toBe("test");
      await op.finish("aborted");
    });

    it("runMetered joins the operation already in scope instead of reserving again", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const outer = await beginOperation(spec(ws, { IMAGE: 1 }));
      await outer.run(async () => {
        await runMetered(
          spec(ws, { AI_MICROS: B(90_000) }, { operationId: "inner" }),
          async () => undefined,
        );
      });
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 0,
        reserved: 0,
      });
      expect(await reservationsOf(ws, "AI_MICROS")).toHaveLength(0);
      await outer.finish("aborted");
    });

    it("runMetered opens its own operation, settles on success and refunds a failure that cost nothing", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      await runMetered(spec(ws, { AI_MICROS: B(90_000) }), async () => {
        getUsageScope()?.meter?.add({
          callId: randomUUID(),
          kind: "TEXT",
          costMicros: B(12_000),
          success: true,
        });
      });
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 12_000,
        reserved: 0,
      });

      await expect(
        runMetered(spec(ws, { AI_MICROS: B(90_000) }), async () => {
          throw new Error("provider exploded");
        }),
      ).rejects.toThrow("provider exploded");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 12_000,
        reserved: 0,
      });
    });

    it("runMetered charges a failure that was billed, up to the reservation", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      await expect(
        runMetered(spec(ws, { AI_MICROS: B(90_000) }), async () => {
          getUsageScope()?.meter?.add({
            callId: randomUUID(),
            kind: "TEXT",
            costMicros: B(50_000),
            success: true,
          });
          throw new Error("unusable output");
        }),
      ).rejects.toThrow("unusable output");
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 50_000,
        reserved: 0,
      });
    });

    it("runMetered does not join an operation that holds no reservation", async () => {
      // A free operation (publishing, an ad write) covers nothing: an AI call
      // inside it must pay for itself.
      const ws = await fundedWorkspace(5, 3_000_000);
      const free = await beginOperation(spec(ws, {}));
      await free.run(async () => {
        await runMetered(spec(ws, { AI_MICROS: B(90_000) }), async () => {
          getUsageScope()?.meter?.add({
            callId: randomUUID(),
            kind: "TEXT",
            costMicros: B(9_000),
            success: true,
          });
        });
      });
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 9_000,
        reserved: 0,
      });
      await free.finish("delivered");
    });

    it("runMetered does not join an operation that has already been settled", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const settled = await beginOperation(spec(ws, { IMAGE: 1 }));
      drawn(settled, 1);
      await settled.finish("delivered");
      await settled.run(async () => {
        await runMetered(spec(ws, { AI_MICROS: B(90_000) }), async () => {
          getUsageScope()?.meter?.add({
            callId: randomUUID(),
            kind: "TEXT",
            costMicros: B(4_000),
            success: true,
          });
        });
      });
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 4_000,
        reserved: 0,
      });
    });

    it("a paid call that lands after its operation was settled is counted apart, not lost into the bill", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));
      spent(op, 10_000);
      await op.finish("delivered");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      spent(op, 7_000); // a race loser that kept running
      expect(op.meter.costMicros).toBe(B(10_000));
      expect(op.meter.lateMicros).toBe(B(7_000));
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      expect(await balanceOf(ws, "AI_MICROS")).toEqual({
        used: 10_000,
        reserved: 0,
      });
    });

    it("does not join an operation that belongs to another workspace", async () => {
      const wsA = await fundedWorkspace(5, 3_000_000);
      const wsB = await fundedWorkspace(5, 3_000_000);
      const outer = await beginOperation(spec(wsA, { IMAGE: 1 }));
      await outer.run(async () => {
        await runMetered(spec(wsB, { AI_MICROS: B(90_000) }), async () =>
          getUsageScope()?.meter?.add({
            callId: randomUUID(),
            kind: "TEXT",
            costMicros: B(7_000),
            success: true,
          }),
        );
      });
      expect(await balanceOf(wsB, "AI_MICROS")).toEqual({
        used: 7_000,
        reserved: 0,
      });
      expect(outer.meter.costMicros).toBe(B(0));
      await outer.finish("aborted");
    });
  });

  describe("leftover holds of one operation", () => {
    it("releases every open hold of a job that is not running any more", async () => {
      const ws = await fundedWorkspace(5, 3_000_000);
      const operationId = `exec:${randomUUID()}`;
      // Two earlier attempts crashed and left holds behind.
      await beginOperation(spec(ws, { IMAGE: 1 }, { operationId, attemptToken: "a.1" }));
      await beginOperation(spec(ws, { IMAGE: 1 }, { operationId, attemptToken: "b.1" }));
      const other = await beginOperation(spec(ws, { IMAGE: 1 })); // someone else's
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 3 });

      const released = await releaseOperationReservations({
        workspaceId: ws,
        operationId,
      });
      expect(released).toBe(2);
      expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 1 });
      await other.finish("aborted");
    });
  });
});
