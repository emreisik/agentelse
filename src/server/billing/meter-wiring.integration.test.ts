import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
// vitest.setup.ts turns the recorder into a no-op for every suite; this one is
// about what the REAL recorder does: it adds the call to the operation's meter
// (what the plan is charged from) and writes the UsageEntry row.
vi.unmock("@/server/billing/usage-recorder");

// Billing mode is set per test (no dependence on the env cache).
const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));

// The real OpenAI image client runs in two tests below. Only its edges are
// doubles: the environment, the stored file and the project activity row.
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    OPENAI_API_KEY: "test-key",
    OPENAI_IMAGE_MODEL: "gpt-image-2",
  }),
}));
vi.mock("@/server/storage/asset-storage", () => ({
  putAsset: vi.fn(async () => ({
    storageKey: "r2://fake.png",
    filename: "fake.png",
  })),
}));
vi.mock("@/server/repositories/reasoning-call.repository", () => ({
  ReasoningCallRepository: { record: vi.fn(async () => ({})) },
}));

import { prisma } from "@/lib/prisma";
import { generateOpenAIImage } from "@/server/reasoning/openai-image-client";
import { describeIntegration } from "@/test-support/integration-suite";

import { beginOperation, type OperationSpec } from "./operation";
import { runWithUsageScope } from "./usage-context";
import { recordUsage, type RecordUsageInput } from "./usage-recorder";

// Does what a paid call costs actually reach the operation's bill? An operation
// settles what its meter counted (a picture for IMAGE rights, micro-dollars for the
// AI budget) and the meter is only fed by recordUsage under a scope that carries
// it. The other suites hand-feed the meter or mock the recorder, so none of them
// proves that link: here the real recordUsage and the real ledger run against real
// Postgres (a throw-away test database, never the shared Neon one).

const B = (value: number) => BigInt(value);
const DAY_MS = 86_400_000;
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_mw_${runId}_${++counter}`;
// Every row a test records by hand carries this prefix, so the cleanup finds even
// the ones recorded without a workspace ("unattributed"). The rows the real image
// client writes carry its own call ids: they are found by their workspace, or, when
// the scope was lost (the very failure these tests are for), as "unattributed" rows
// written since this file started.
const newCallId = () => `mw_${runId}_${++counter}`;

// An open plan window around now, derived from the clock.
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - 10 * DAY_MS);
const WINDOW_END = new Date(NOW.getTime() + 20 * DAY_MS);

type Unit = "IMAGE" | "AI_MICROS";

// A workspace with a valid plan and both balances.
async function fundedWorkspace(images: number, micros: number) {
  const ws = newWs();
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
  for (const [unit, granted] of [
    ["IMAGE", images],
    ["AI_MICROS", micros],
  ] as const) {
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId: ws,
        unit,
        periodStart: WINDOW_START,
        periodEnd: WINDOW_END,
        periodGranted: B(granted),
        updatedAt: NOW,
      },
    });
  }
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
    ...overrides,
  };
}

// A drawn picture as an image client reports it (openai-image-client.ts and
// fal-image-client.ts; their own tests pin this shape).
const drawnPicture = (
  overrides: Partial<RecordUsageInput> = {},
): RecordUsageInput => ({
  kind: "IMAGE",
  provider: "openai",
  model: "gpt-image-2/high",
  costUsd: 0.211,
  costEstimated: true,
  success: true,
  durationMs: 1,
  units: 1,
  callId: newCallId(),
  ...overrides,
});

// A paid text call (art direction, copy, a research report).
const paidText = (
  costUsd: number,
  overrides: Partial<RecordUsageInput> = {},
): RecordUsageInput => ({
  kind: "TEXT",
  provider: "openai",
  model: "gpt-5.6-luna",
  costUsd,
  costEstimated: false,
  success: true,
  durationMs: 1,
  callId: newCallId(),
  ...overrides,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describeIntegration(
  "what a paid call costs reaches the operation's bill",
  () => {
    afterEach(() => {
      config.current = {
        mode: "enforce",
        legacyBefore: null,
        legacyUntil: null,
      };
      vi.unstubAllGlobals();
    });

    afterAll(async () => {
      const where = { workspaceId: { startsWith: `ws_mw_${runId}` } };
      await prisma.usageEntry.deleteMany({
        where: {
          OR: [
            where,
            { callId: { startsWith: `mw_${runId}_` } },
            { workspaceId: "unattributed", createdAt: { gte: NOW } },
          ],
        },
      });
      await prisma.usageReservation.deleteMany({ where });
      await prisma.usageGrant.deleteMany({ where });
      await prisma.usageBalance.deleteMany({ where });
      await prisma.subscription.deleteMany({ where });
    });

    describe("a drawn picture (IMAGE rights)", () => {
      it("charges the picture an image client recorded inside the operation, and stamps its row with the operation", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 1 });

        await op.run(() => recordUsage(drawnPicture()));

        expect(op.meter.images).toBe(1);
        await op.finish("delivered");
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
        // The ledger row of the same call belongs to the same operation.
        const rows = await prisma.usageEntry.findMany({
          where: { operationId: op.operationId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          workspaceId: ws,
          kind: "IMAGE",
          success: true,
          units: 1,
        });
      });

      it("charges a call that carries the operation's scope explicitly, as chat turns do (no async context)", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        await recordUsage(drawnPicture({ scope: op.scope() }));
        await op.finish("delivered");

        expect(op.meter.images).toBe(1);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
      });

      it("does not charge a call made outside the operation's scope", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 2 }));

        // No scope at all (an unattributed call) ...
        await recordUsage(drawnPicture());
        // ... and the same workspace under some other operation.
        await runWithUsageScope(
          { workspaceId: ws, operationId: `exec:${randomUUID()}` },
          () => recordUsage(drawnPicture()),
        );
        // The only picture this operation drew.
        await op.run(() => recordUsage(drawnPicture()));
        await op.finish("delivered");

        expect(op.meter.images).toBe(1);
        // 2 held, 1 drawn by this operation: 1 charged, the other handed back.
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
      });

      it("never charges a call that belongs to another workspace, however it got into the scope", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const other = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        await op.run(async () => {
          // A nested scope that switches workspace drops the meter ...
          await runWithUsageScope(
            { workspaceId: other, operationId: `exec:${randomUUID()}` },
            () => recordUsage(drawnPicture()),
          );
          // ... and a call that names another workspace inside this one is not added.
          await recordUsage(drawnPicture({ scope: { workspaceId: other } }));
        });
        await op.finish("delivered");

        expect(op.meter.images).toBe(0);
        expect(op.meter.costMicros).toBe(B(0));
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
        expect(await balanceOf(other, "IMAGE")).toEqual({
          used: 0,
          reserved: 0,
        });
        // The rows themselves are kept, under the workspace that paid for them.
        expect(
          await prisma.usageEntry.count({ where: { workspaceId: other } }),
        ).toBe(2);
        expect(
          await prisma.usageEntry.count({ where: { workspaceId: ws } }),
        ).toBe(0);
      });

      it("charges nothing for a failed attempt, even when the work is reported as delivered", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        await op.run(() =>
          recordUsage(
            drawnPicture({
              success: false,
              units: 0,
              costUsd: 0,
              errorCode: "NETWORK",
            }),
          ),
        );
        await op.finish("delivered");

        expect(op.meter.images).toBe(0);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
      });

      it("charges as many pictures as one call reports, so the recorder hands the call's units on to the meter", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 3 }));

        await op.run(() => recordUsage(drawnPicture({ units: 2 })));
        await op.finish("delivered");

        expect(op.meter.images).toBe(2);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 2, reserved: 0 });
      });

      it("never charges more pictures than were held, however many renders were billed (a re-render or a fallback is not a second right)", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        // The first render was billed but could not be used; the fallback drew another.
        await op.run(async () => {
          await recordUsage(drawnPicture());
          await recordUsage(
            drawnPicture({ provider: "fal", model: "fal-ai/flux/schnell" }),
          );
        });
        await op.finish("delivered");

        expect(op.meter.images).toBe(2);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
      });

      it("charges the real OpenAI image client's picture: client, recorder, meter and ledger together", async () => {
        vi.stubGlobal(
          "fetch",
          vi
            .fn()
            .mockResolvedValue(
              jsonResponse(200, { data: [{ b64_json: ONE_PX_PNG_B64 }] }),
            ),
        );
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(
          spec(ws, { IMAGE: 1 }, { purpose: "logo.generate" }),
        );

        const image = await op.run(() => generateOpenAIImage("a red apple"));
        expect(image).not.toBeNull();
        await op.finish("delivered");

        expect(op.meter.images).toBe(1);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 1, reserved: 0 });
        const rows = await prisma.usageEntry.findMany({
          where: { operationId: op.operationId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          workspaceId: ws,
          kind: "IMAGE",
          provider: "openai",
          purpose: "logo.generate",
          units: 1,
          success: true,
        });
      });

      it("charges nothing when the real image client's request dies", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn().mockRejectedValue(new Error("network down")),
        );
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        const image = await op.run(() => generateOpenAIImage("a red apple"));
        error.mockRestore();
        expect(image).toBeNull();
        await op.finish("delivered");

        expect(op.meter.images).toBe(0);
        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
        // The attempt is on record, as a failure that drew nothing.
        const rows = await prisma.usageEntry.findMany({
          where: { operationId: op.operationId },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: "IMAGE",
          success: false,
          units: 0,
          errorCode: "NETWORK",
        });
      });
    });

    describe("paid text (AI budget)", () => {
      it("settles what the paid calls recorded inside the operation cost", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));

        await op.run(async () => {
          await recordUsage(paidText(0.0123));
          await recordUsage(
            paidText(0.004, { kind: "SEARCH", webSearchCalls: 1 }),
          );
        });
        await op.finish("delivered");

        // 12 300 + 4 000 micro-dollars; the estimate it held (90 000) is not the bill.
        expect(op.meter.costMicros).toBe(B(16_300));
        expect(await balanceOf(ws, "AI_MICROS")).toEqual({
          used: 16_300,
          reserved: 0,
        });
      });

      it("does not settle a paid call made outside the operation's scope", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));

        await recordUsage(paidText(0.05));
        await runWithUsageScope(
          { workspaceId: ws, operationId: `exec:${randomUUID()}` },
          () => recordUsage(paidText(0.05)),
        );
        await op.run(() => recordUsage(paidText(0.0123)));
        await op.finish("delivered");

        expect(await balanceOf(ws, "AI_MICROS")).toEqual({
          used: 12_300,
          reserved: 0,
        });
      });

      it("charges the text a picture operation paid for when no picture came out", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { IMAGE: 1 }));

        // The art direction ran, the image model then refused the brief.
        await op.run(() => recordUsage(paidText(0.02)));
        await op.finish("delivered");

        expect(await balanceOf(ws, "IMAGE")).toEqual({ used: 0, reserved: 0 });
        expect(await balanceOf(ws, "AI_MICROS")).toEqual({
          used: 20_000,
          reserved: 0,
        });
      });

      it("keeps a billed call that failed on the bill, up to the reservation", async () => {
        const ws = await fundedWorkspace(5, 3_000_000);
        const op = await beginOperation(spec(ws, { AI_MICROS: B(90_000) }));

        // A long answer was billed, then turned out unusable.
        await op.run(() => recordUsage(paidText(0.4)));
        await op.finish("failed");

        expect(await balanceOf(ws, "AI_MICROS")).toEqual({
          used: 90_000,
          reserved: 0,
        });
      });
    });
  },
);
