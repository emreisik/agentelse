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
  cap: 100,
}));
vi.mock("./config", () => ({ getBillingConfig: () => config.current }));
vi.mock("@/lib/env", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), TRIAL_MAX_PER_DAY: config.cap }),
  };
});

import { prisma } from "@/lib/prisma";
import { TRIAL, trialQuota } from "@/lib/billing/plans";
import { describeIntegration } from "@/test-support/integration-suite";

import { getEntitlements } from "./entitlements";
import { startSignupTrial } from "./subscription";

// The trial a brand-new workspace gets at signup: written only while billing is on, never
// for the legacy cohort, capped per day, never throws. Real Postgres.

const runId = randomUUID().slice(0, 8);
let counter = 0;
const newWs = () => `ws_trial_${runId}_${++counter}`;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const rowOf = (workspaceId: string) =>
  prisma.subscription.findUnique({ where: { workspaceId } });

describeIntegration("trial at signup", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    config.cap = 100;
  });

  afterAll(async () => {
    const where = { workspaceId: { startsWith: `ws_trial_${runId}` } };
    await prisma.usageReservation.deleteMany({ where });
    await prisma.usageGrant.deleteMany({ where });
    await prisma.usageBalance.deleteMany({ where });
    await prisma.subscription.deleteMany({ where });
  });

  it("gives a new workspace a 7-day trial with the trial allowance, while billing is on", async () => {
    for (const mode of ["shadow", "enforce"] as const) {
      config.current = { ...config.current, mode };
      const workspaceId = newWs();

      const result = await startSignupTrial(workspaceId, { now: NOW });

      expect(result).toEqual({
        started: true,
        trialEndsAt: new Date(NOW.getTime() + 7 * DAY),
      });
      expect(await rowOf(workspaceId)).toMatchObject({
        status: "TRIALING",
        planKey: null,
        trialEndsAt: new Date(NOW.getTime() + TRIAL.days * DAY),
      });
      const images = await prisma.usageBalance.findUniqueOrThrow({
        where: { workspaceId_unit: { workspaceId, unit: "IMAGE" } },
      });
      expect(Number(images.periodGranted)).toBe(trialQuota().IMAGE);
    }
  });

  it("while enforced, the trial gives full access that ends with the trial", async () => {
    const workspaceId = newWs();
    await startSignupTrial(workspaceId, { now: NOW });

    expect(await getEntitlements(workspaceId, { now: NOW })).toMatchObject({
      access: "FULL",
      reason: "TRIAL",
      isTrial: true,
    });
    expect(
      await getEntitlements(workspaceId, {
        now: new Date(NOW.getTime() + 8 * DAY),
      }),
    ).toMatchObject({ access: "READ_ONLY", reason: "TRIAL_ENDED" });
  });

  it("writes NOTHING while billing is off (a row would take a workspace out of the legacy cohort)", async () => {
    config.current = { ...config.current, mode: "off" };
    const workspaceId = newWs();

    expect(await startSignupTrial(workspaceId, { now: NOW })).toEqual({
      started: false,
      reason: "BILLING_OFF",
    });
    expect(await rowOf(workspaceId)).toBeNull();
  });

  it("gives no trial to a signup that still belongs to the legacy cohort", async () => {
    // The cohort cut-off is in the future: everything opened before it is an existing customer.
    config.current = {
      ...config.current,
      legacyBefore: new Date(NOW.getTime() + 10 * DAY),
    };
    const early = newWs();
    expect(await startSignupTrial(early, { now: NOW })).toEqual({
      started: false,
      reason: "LEGACY_COHORT",
    });
    expect(await rowOf(early)).toBeNull();

    // After the cut-off a signup is a new customer and gets the trial.
    const late = newWs();
    expect(
      await startSignupTrial(late, {
        now: new Date(NOW.getTime() + 11 * DAY),
      }),
    ).toMatchObject({ started: true });
  });

  it("is idempotent: a second call never gives a second trial", async () => {
    const workspaceId = newWs();
    expect(await startSignupTrial(workspaceId, { now: NOW })).toMatchObject({
      started: true,
    });

    expect(
      await startSignupTrial(workspaceId, {
        now: new Date(NOW.getTime() + DAY),
      }),
    ).toEqual({ started: false, reason: "ALREADY_TRIALED" });
    const row = await rowOf(workspaceId);
    expect(row?.trialEndsAt).toEqual(new Date(NOW.getTime() + 7 * DAY));
  });

  describe("the daily cap", () => {
    // Own clock far from the others so rows from other tests do not count.
    const T = new Date("2031-03-10T12:00:00.000Z");

    it("stops handing out trials once the cap is reached in the last 24 hours, and explains it in the log", async () => {
      config.cap = 3;
      const already = await prisma.subscription.count({
        where: { trialEndsAt: { gt: new Date(T.getTime() + 6 * DAY) } },
      });
      expect(already).toBe(0);

      const started = [];
      for (let i = 0; i < 3; i += 1) {
        started.push(
          await startSignupTrial(newWs(), {
            now: new Date(T.getTime() + i * 60_000),
          }),
        );
      }
      const blocked = newWs();
      const over = await startSignupTrial(blocked, {
        now: new Date(T.getTime() + 10 * 60_000),
      });

      expect(started.every((result) => result.started)).toBe(true);
      expect(over).toEqual({ started: false, reason: "DAILY_CAP" });
      expect(await rowOf(blocked)).toBeNull();
      expect(
        vi
          .mocked(console.error)
          .mock.calls.some((call) =>
            String(call[0]).includes("TRIAL_MAX_PER_DAY"),
          ),
      ).toBe(true);
    });

    it("counts only trials that started in the last 24 hours: a day later the doors open again", async () => {
      config.cap = 3;
      const later = new Date(T.getTime() + 25 * 60 * 60 * 1000);

      const result = await startSignupTrial(newWs(), { now: later });

      expect(result).toMatchObject({ started: true });
    });

    it("0 switches signup trials off", async () => {
      config.cap = 0;

      expect(
        await startSignupTrial(newWs(), {
          now: new Date("2032-01-05T12:00:00.000Z"),
        }),
      ).toEqual({ started: false, reason: "DAILY_CAP" });
    });
  });

  it("never throws: a failure while starting leaves the workspace without a trial", async () => {
    vi.spyOn(prisma.subscription, "count").mockRejectedValueOnce(
      new Error("database is down"),
    );

    const result = await startSignupTrial(newWs(), { now: NOW });

    expect(result).toEqual({ started: false, reason: "ERROR" });
    expect(console.error).toHaveBeenCalled();
  });
});
