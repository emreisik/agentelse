import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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
import { BACKGROUND_SHARE_PCT, heldBackPct } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { reserveUsage } from "./ledger";
import { beginOperation } from "./operation";
import { QuotaExceededError } from "./quota-errors";
import { resetShadowLogThrottle } from "./shadow-log";
import { runAsBackground } from "./usage-context";

// The part of a plan the system's own work cannot touch (Faz 3C), against a real
// Postgres: a limited plan (Starter) lets background work use 45% of the window's
// allowance, a full one 70%; whatever the user starts is never held back.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_share_${runId}_${++counter}`;

const NOW = new Date("2026-11-15T12:00:00.000Z");
const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-12-01T00:00:00.000Z");

async function workspace(
  planKey: "starter" | "growth",
  allowance: { granted: number; used?: number; extra?: number },
) {
  const workspaceId = newWs();
  await prisma.subscription.create({
    data: {
      workspaceId,
      planKey,
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: WINDOW_END,
    },
  });
  await prisma.usageBalance.create({
    data: {
      id: randomUUID(),
      workspaceId,
      unit: "IMAGE",
      periodStart: WINDOW_START,
      periodEnd: WINDOW_END,
      periodGranted: B(allowance.granted),
      periodUsed: B(allowance.used ?? 0),
      extraGranted: B(allowance.extra ?? 0),
      updatedAt: NOW,
    },
  });
  return workspaceId;
}

let keyCounter = 0;
const reserve = (
  workspaceId: string,
  initiator: "user" | "system" | undefined,
  amount = 1,
) =>
  reserveUsage({
    workspaceId,
    unit: "IMAGE",
    amount,
    reservationKey: `share-${++keyCounter}#1`,
    initiator,
    now: NOW,
  });

describe("the shares", () => {
  it("hold back the rest of the allowance for the user", () => {
    expect(BACKGROUND_SHARE_PCT).toEqual({ limited: 45, full: 70 });
    expect(heldBackPct("limited")).toBe(55);
    expect(heldBackPct("full")).toBe(30);
  });
});

describeIntegration("background share of the plan allowance", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    resetShadowLogThrottle();
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_share_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
  });

  describe("reserveUsage", () => {
    it("a full plan lets the system use 70% of the window; the last 30% is the user's", async () => {
      const ws = await workspace("growth", { granted: 10 });

      // 7 are the system's to use...
      for (let i = 0; i < 7; i += 1) {
        expect(await reserve(ws, "system")).toMatchObject({
          ok: true,
          kind: "RESERVED",
        });
      }
      // ...the 8th would eat into the user's 3.
      expect(await reserve(ws, "system")).toMatchObject({
        ok: false,
        reason: "INSUFFICIENT",
      });
      // The user is not held back at all: all 3 left are theirs.
      for (let i = 0; i < 3; i += 1) {
        expect(await reserve(ws, "user")).toMatchObject({
          ok: true,
          kind: "RESERVED",
        });
      }
      expect(await reserve(ws, "user")).toMatchObject({
        ok: false,
        reason: "INSUFFICIENT",
      });
    });

    it("a limited plan (Starter) holds back more: the system may use 45%", async () => {
      const ws = await workspace("starter", { granted: 20 });

      // floor(20 * 55 / 100) = 11 stay for the user: the system gets 9.
      for (let i = 0; i < 9; i += 1) {
        expect(await reserve(ws, "system")).toMatchObject({
          ok: true,
          kind: "RESERVED",
        });
      }
      expect(await reserve(ws, "system")).toMatchObject({
        ok: false,
        reason: "INSUFFICIENT",
      });
      for (let i = 0; i < 11; i += 1) {
        expect(await reserve(ws, "user")).toMatchObject({ ok: true });
      }
    });

    it("an unlabeled reservation is the user's: it is never held back", async () => {
      const ws = await workspace("starter", { granted: 4 });
      for (let i = 0; i < 4; i += 1) {
        expect(await reserve(ws, undefined)).toMatchObject({
          ok: true,
          kind: "RESERVED",
        });
      }
    });

    it("what the user already used counts: the system sees only what is left above the user's share", async () => {
      const ws = await workspace("growth", { granted: 10, used: 6 });

      // 4 left, 3 of them held back for the user: the system can take 1.
      expect(await reserve(ws, "system")).toMatchObject({ ok: true });
      expect(await reserve(ws, "system")).toMatchObject({
        ok: false,
        reason: "INSUFFICIENT",
      });
    });

    it("extra packs count as available but the held-back part is measured on the window's allowance", async () => {
      const ws = await workspace("growth", { granted: 10, used: 10, extra: 5 });

      // Window is empty, 5 extra: floor is 3 (30% of 10), so the system can take 2 of them.
      expect(await reserve(ws, "system", 2)).toMatchObject({ ok: true });
      expect(await reserve(ws, "system", 1)).toMatchObject({ ok: false });
      expect(await reserve(ws, "user", 3)).toMatchObject({ ok: true });
    });

    it("in shadow mode a system reservation over the line is recorded as 'would be blocked', never refused", async () => {
      config.current = {
        mode: "shadow",
        legacyBefore: null,
        legacyUntil: null,
      };
      const ws = await workspace("growth", { granted: 10, used: 8 });

      const result = await reserve(ws, "system");

      expect(result).toMatchObject({ ok: true, kind: "OVERDRAFT_SHADOW" });
    });

    // The user's part is rounded UP: on a small allowance the system must not take
    // more than its share (floor would give a 5-image Starter trial's system 60%).
    it.each([
      // [plan, granted, what the system may use]
      ["starter", 3, 1],
      ["starter", 5, 2],
      ["starter", 10, 4],
      ["starter", 20, 9],
      ["growth", 3, 2],
      ["growth", 5, 3],
      ["growth", 10, 7],
      ["growth", 20, 14],
    ] as const)(
      "%s with %i granted: the system may use %i, the rest is the user's",
      async (plan, granted, systemMay) => {
        const ws = await workspace(plan, { granted });
        let taken = 0;
        while ((await reserve(ws, "system")).ok) taken += 1;
        expect(taken).toBe(systemMay);
        // Whatever the system could not take is the user's, all of it.
        for (let i = 0; i < granted - taken; i += 1) {
          expect(await reserve(ws, "user")).toMatchObject({ ok: true });
        }
      },
    );

    it("a refusal says whether it was the user's share or the allowance itself that ran out", async () => {
      const ws = await workspace("growth", { granted: 10, used: 7 });

      // 3 left, all held back: the user would fit, the system does not.
      expect(await reserve(ws, "system")).toMatchObject({
        ok: false,
        reason: "INSUFFICIENT",
        heldBack: true,
      });
      // Asking for more than is left is the allowance running out, for anyone.
      expect(await reserve(ws, "user", 4)).toMatchObject({
        ok: false,
        heldBack: false,
      });
      expect(await reserve(ws, "system", 4)).toMatchObject({
        ok: false,
        heldBack: false,
      });
      // Nothing left at all.
      const empty = await workspace("growth", { granted: 10, used: 10 });
      expect(await reserve(empty, "system")).toMatchObject({
        ok: false,
        heldBack: false,
      });
    });
  });

  describe("shadow log", () => {
    const shadowRows = (workspaceId: string) =>
      prisma.auditLog.findMany({
        where: { workspaceId, action: "billing.shadow.insufficient" },
        orderBy: { createdAt: "asc" },
      });

    it("says who asked and what was held, and a system floor hit does not hide the user's shortfall", async () => {
      config.current = {
        mode: "shadow",
        legacyBefore: null,
        legacyUntil: null,
      };
      const ws = await workspace("growth", { granted: 10, used: 7 });

      // The system runs into the user's share first ...
      await reserve(ws, "system");
      // ... and the user then asks for more than is left. Both are recorded.
      await reserve(ws, "user", 4);
      // A second system hit in the same hour adds nothing.
      await reserve(ws, "system");

      const rows = await shadowRows(ws);
      expect(rows.map((row) => row.metadata)).toEqual([
        expect.objectContaining({
          initiator: "system",
          heldBack: true,
          held: "3",
          available: "3",
          amount: "1",
        }),
        expect.objectContaining({
          initiator: "user",
          heldBack: false,
          amount: "4",
        }),
      ]);
    });
  });

  describe("beginOperation", () => {
    const spec = (workspaceId: string, initiator?: "user" | "system") => ({
      workspaceId,
      operationId: `op-${randomUUID()}`,
      attemptToken: "t1",
      reserve: { IMAGE: 1 },
      initiator,
      now: NOW,
    });

    it("an explicit system initiator is held back, an explicit user is not", async () => {
      const ws = await workspace("growth", { granted: 10, used: 7 });

      await expect(beginOperation(spec(ws, "system"))).rejects.toBeInstanceOf(
        QuotaExceededError,
      );
      const op = await beginOperation(spec(ws, "user"));
      expect(op.holdsReservation).toBe(true);
    });

    it("work started inside the background marker counts as the system's, unless it says otherwise", async () => {
      const ws = await workspace("growth", { granted: 10, used: 7 });

      await expect(
        runAsBackground(() => beginOperation(spec(ws))),
      ).rejects.toBeInstanceOf(QuotaExceededError);
      // Outside the marker (a request from the user) the same reservation goes through.
      expect((await beginOperation(spec(ws))).holdsReservation).toBe(true);
    });

    it("an explicit label wins over the marker", async () => {
      const ws = await workspace("growth", { granted: 10, used: 7 });
      const op = await runAsBackground(() => beginOperation(spec(ws, "user")));
      expect(op.holdsReservation).toBe(true);
    });

    it("billing off never reads the ledger, whoever started the work", async () => {
      config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
      const ws = await workspace("growth", { granted: 10, used: 10 });
      const op = await runAsBackground(() => beginOperation(spec(ws)));
      expect(op.holdsReservation).toBe(false);
    });
  });
});
