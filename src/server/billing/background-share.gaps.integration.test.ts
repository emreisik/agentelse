import { randomUUID } from "node:crypto";

import type { ActorType, TaskPriority } from "@prisma/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";

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
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { reserveUsage } from "./ledger";
import { resumeParkedWork } from "./park";

// Gaps found by the mutation review of Faz 3C-1 (the background share): the share only
// exists while the window is open, it covers the AI budget too, and the resume sweep
// keeps strict priority between the system's jobs and the user's jobs.

const B = (value: number) => BigInt(value);
const runId = randomUUID().slice(0, 8);
let counter = 0;
const fixtures: AgencyFixture[] = [];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-15T12:00:00.000Z");
const WINDOW_START = new Date("2026-11-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-12-01T00:00:00.000Z");

async function workspace(options: {
  images?: { granted: number; used?: number; extra?: number };
  micros?: { granted: number; used?: number };
  paidThrough?: Date;
  windowEnd?: Date;
}) {
  const fixture = await createAgencyFixture(`bg-${runId}-${counter++}`);
  fixtures.push(fixture);
  await prisma.subscription.create({
    data: {
      workspaceId: fixture.workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: WINDOW_START,
      paidThrough: options.paidThrough ?? WINDOW_END,
      updatedAt: new Date(NOW.getTime() - 90 * DAY),
    },
  });
  for (const [unit, spec] of [
    ["IMAGE", options.images],
    ["AI_MICROS", options.micros],
  ] as const) {
    if (!spec) continue;
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId: fixture.workspaceId,
        unit,
        periodStart: WINDOW_START,
        periodEnd: options.windowEnd ?? WINDOW_END,
        periodGranted: B(spec.granted),
        periodUsed: B(spec.used ?? 0),
        extraGranted: B("extra" in spec ? (spec.extra ?? 0) : 0),
        updatedAt: NOW,
      },
    });
  }
  return fixture;
}

let keyCounter = 0;
const reserve = (
  workspaceId: string,
  unit: "IMAGE" | "AI_MICROS",
  initiator: "user" | "system",
  amount: number,
) =>
  reserveUsage({
    workspaceId,
    unit,
    amount,
    reservationKey: `gap-${++keyCounter}#1`,
    initiator,
    now: NOW,
  });

describeIntegration("background share: gaps", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("the share is measured on the AI budget as well as on images", async () => {
    const { workspaceId } = await workspace({
      micros: { granted: 10_000_000, used: 8_000_000 },
    });

    // 2,000,000 left, 3,000,000 (30%) are the user's: the system cannot take any.
    expect(
      await reserve(workspaceId, "AI_MICROS", "system", 500_000),
    ).toMatchObject({ ok: false, reason: "INSUFFICIENT" });
    expect(
      await reserve(workspaceId, "AI_MICROS", "user", 500_000),
    ).toMatchObject({ ok: true, kind: "RESERVED" });
  });

  it("the share exists only while the window is open: after it closed the system may spend extra packs", async () => {
    // Renewal is late (inside the grace after paidThrough): the window ended, a new one
    // cannot open yet, and what is left is the extra pack.
    const paidThrough = new Date(NOW.getTime() - HOUR);
    const { workspaceId } = await workspace({
      images: { granted: 10, used: 0, extra: 5 },
      paidThrough,
      windowEnd: paidThrough,
    });

    const result = await reserve(workspaceId, "IMAGE", "system", 5);

    expect(result).toMatchObject({
      ok: true,
      kind: "RESERVED",
      fromExtra: B(5),
    });
  });
});

describeIntegration(
  "resume sweep: strict priority with the system's jobs",
  () => {
    afterEach(() => {
      config.current = {
        mode: "enforce",
        legacyBefore: null,
        legacyUntil: null,
      };
    });

    afterAll(async () => {
      for (const fixture of fixtures.splice(0)) {
        await teardownAgencyFixture(fixture.workspaceId);
      }
    });

    async function parked(
      fixture: AgencyFixture,
      seed: {
        createdBy: ActorType;
        priority: TaskPriority;
        variants?: number;
      },
    ) {
      const task = await prisma.task.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          title: `Task ${randomUUID().slice(0, 6)}`,
          capability: "CREATE_SOCIAL_CREATIVE",
          status: "QUEUED",
          priority: seed.priority,
          riskLevel: "MEDIUM",
          createdByType: seed.createdBy,
        },
      });
      const job = await prisma.executionJob.create({
        data: {
          workspaceId: fixture.workspaceId,
          projectId: fixture.projectId,
          brandId: fixture.brandId,
          taskId: task.id,
          capability: "CREATE_SOCIAL_CREATIVE",
          providerType: "SYSTEM",
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          requestPayload: {
            request: "a post",
            ...(seed.variants ? { variantCount: seed.variants } : {}),
          } as never,
          status: "WAITING_BUDGET",
          updatedAt: new Date(NOW.getTime() - HOUR),
        },
      });
      return job.id;
    }
    const statusOf = async (jobId: string) =>
      (await prisma.executionJob.findUniqueOrThrow({ where: { id: jobId } }))
        .status;

    it("a system job that does not fit holds back the smaller, lower-priority system jobs behind it", async () => {
      // Growth: 6 granted, 3 used; the user's protected share is rounded UP, 2 of 6. 3 images
      // left: a 3-image system job needs 3 + 2 and does not fit; a 1-image one (1 + 2) would.
      const fixture = await workspace({ images: { granted: 6, used: 3 } });
      const big = await parked(fixture, {
        createdBy: "SYSTEM",
        priority: "HIGH",
        variants: 3,
      });
      const small = await parked(fixture, {
        createdBy: "AI",
        priority: "LOW",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary).toEqual({ resumed: 0, cancelled: 0, stillParked: 2 });
      expect(await statusOf(big)).toBe("WAITING_BUDGET");
      expect(await statusOf(small)).toBe("WAITING_BUDGET");
      // Premise: on its own the small job fits, so it is the queue that holds it back.
      expect(
        await reserve(fixture.workspaceId, "IMAGE", "system", 1),
      ).toMatchObject({ ok: true, kind: "RESERVED" });
    });

    it("a user job that does not fit holds back the system's smaller jobs behind it", async () => {
      // 2 images left of 3. The user's 3-image job (HIGH, the most a post draws) does not
      // fit; the system's 1-image job would (1 + the 1 kept for the user), but it must not
      // jump the queue.
      const fixture = await workspace({ images: { granted: 3, used: 1 } });
      const user = await parked(fixture, {
        createdBy: "USER",
        priority: "HIGH",
        variants: 3,
      });
      const system = await parked(fixture, {
        createdBy: "SYSTEM",
        priority: "MEDIUM",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary).toEqual({ resumed: 0, cancelled: 0, stillParked: 2 });
      expect(await statusOf(user)).toBe("WAITING_BUDGET");
      expect(await statusOf(system)).toBe("WAITING_BUDGET");
      // Premise: on its own the system job fits (1 + the 1 kept = 2 of the 2 left).
      expect(
        await reserve(fixture.workspaceId, "IMAGE", "system", 1),
      ).toMatchObject({ ok: true, kind: "RESERVED" });
    });

    it("control: with room for both, the user's job and the system's job both go", async () => {
      const fixture = await workspace({ images: { granted: 6, used: 0 } });
      const user = await parked(fixture, {
        createdBy: "USER",
        priority: "HIGH",
        variants: 3,
      });
      const system = await parked(fixture, {
        createdBy: "SYSTEM",
        priority: "MEDIUM",
      });

      const summary = await resumeParkedWork({
        workspaceId: fixture.workspaceId,
        now: NOW,
      });

      expect(summary.resumed).toBe(2);
      expect(await statusOf(user)).toBe("QUEUED");
      expect(await statusOf(system)).toBe("QUEUED");
    });
  },
);
