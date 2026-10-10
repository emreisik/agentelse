import { randomUUID } from "node:crypto";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

// Off unless a test says otherwise (what the environment gives without a setting).
const config = vi.hoisted(() => ({
  current: {
    mode: "off" as "off" | "shadow" | "enforce",
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

import { getBillingOverview } from "./overview";

// The Plan & usage screens' data, read from a real database: what the workspace has
// (plan, balances), what it has used (the measured usage rows) and the work that is
// waiting. Only this workspace's rows, only this month's, only successful calls.

const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];
const B = (value: number) => BigInt(value);
const DAY_MS = 24 * 60 * 60 * 1000;

async function workspace() {
  const fixture = await createAgencyFixture(`${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  return fixture;
}

async function usage(
  fixture: AgencyFixture,
  row: {
    kind: "IMAGE" | "TEXT" | "SEARCH";
    module?: string;
    success?: boolean;
    units?: number;
    at: Date;
  },
) {
  await prisma.usageEntry.create({
    data: {
      workspaceId: fixture.workspaceId,
      module: row.module ?? "SOCIAL",
      callId: randomUUID(),
      kind: row.kind,
      purpose: "test",
      provider: "openai",
      model: "test",
      units: row.units ?? (row.kind === "IMAGE" ? 1 : undefined),
      costMicros: B(10_000),
      costEstimated: false,
      success: row.success ?? true,
      durationMs: 1,
      priceTable: "test",
      createdAt: row.at,
    },
  });
}

async function job(
  fixture: AgencyFixture,
  status: "QUEUED" | "WAITING_BUDGET",
  options: { errorCode?: string; title: string },
) {
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      title: options.title,
      capability: "CREATE_COPY",
      status: "QUEUED",
      riskLevel: "LOW",
      createdByType: "USER",
    },
  });
  await prisma.executionJob.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      taskId: task.id,
      capability: "CREATE_COPY",
      providerType: "SYSTEM",
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestPayload: {} as never,
      status,
      errorCode: options.errorCode,
    },
  });
  return task;
}

describeIntegration("getBillingOverview", () => {
  afterEach(() => {
    config.current = { mode: "off", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures) {
      const where = { workspaceId: fixture.workspaceId };
      await prisma.usageEntry.deleteMany({ where });
      await prisma.approval.deleteMany({ where });
      await prisma.executionJob.deleteMany({ where });
      await prisma.task.deleteMany({ where });
      await prisma.usageBalance.deleteMany({ where });
      await prisma.subscription.deleteMany({ where });
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("is empty and honest for a workspace with nothing yet", async () => {
    const fixture = await workspace();
    const overview = await getBillingOverview(fixture.workspaceId);

    expect(overview.subscription).toBeNull();
    expect(overview.allowances).toEqual([]);
    expect(overview.measured.images).toBe(0);
    expect(overview.measured.aiRequests).toBe(0);
    expect(overview.measured.byModule).toEqual([]);
    expect(overview.measured.daily).toEqual([]);
    expect(overview.tasks).toEqual({
      active: [],
      paused: [],
      awaitingApproval: [],
    });
  });

  it("reads the plan and the balances: this window's allowance plus extra packs, images first", async () => {
    const fixture = await workspace();
    const now = new Date();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: new Date(now.getTime() - 5 * DAY_MS),
        paidThrough: new Date(now.getTime() + 25 * DAY_MS),
        cancelAtPeriodEnd: true,
      },
    });
    const windowEnd = new Date(now.getTime() + 25 * DAY_MS);
    for (const [unit, granted, used, reserved, extraGranted] of [
      ["AI_MICROS", 8_000_000, 2_000_000, 500_000, 0],
      ["IMAGE", 50, 20, 3, 20],
    ] as const) {
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          unit,
          periodStart: new Date(now.getTime() - 5 * DAY_MS),
          periodEnd: windowEnd,
          periodGranted: B(granted),
          periodUsed: B(used),
          periodReserved: B(reserved),
          extraGranted: B(extraGranted),
          updatedAt: now,
        },
      });
    }

    const overview = await getBillingOverview(fixture.workspaceId, now);

    expect(overview.subscription).toMatchObject({
      planKey: "growth",
      planLabel: "Growth",
      interval: "MONTH",
      status: "ACTIVE",
      cancelAtPeriodEnd: true,
      pending: null,
    });
    expect(overview.allowances.map((row) => row.unit)).toEqual([
      "IMAGE",
      "AI_MICROS",
    ]);
    const [images, ai] = overview.allowances;
    expect(images).toMatchObject({
      granted: 70, // 50 of the window + 20 bought
      used: 20,
      reserved: 3,
      available: 47, // 50 - 20 - 3 + 20
      extraAvailable: 20,
      endsAt: windowEnd.toISOString(),
    });
    expect(ai).toMatchObject({
      granted: 8_000_000,
      used: 2_000_000,
      available: 5_500_000,
      extraAvailable: 0,
    });
  });

  it("tells a paying workspace from one that never paid, and keeps paid time after a cancel", async () => {
    const now = new Date();
    const future = new Date(now.getTime() + 10 * DAY_MS);
    const past = new Date(now.getTime() - 10 * DAY_MS);
    const cases = [
      // [row, stripeLinked, paidAccess]
      [{ status: "ACTIVE", stripeSubscriptionId: null }, false, false],
      [{ status: "TRIALING", stripeSubscriptionId: null }, false, false],
      [
        {
          status: "ACTIVE",
          stripeSubscriptionId: "sub_a",
          paidThrough: future,
        },
        true,
        true,
      ],
      // Paid time (plus the renewal lag) ran out: the plan is not running any more.
      [
        {
          status: "ACTIVE",
          stripeSubscriptionId: "sub_a2",
          paidThrough: past,
        },
        true,
        false,
      ],
      // Payment trouble: the plan still works only inside the grace period.
      [
        {
          status: "PAST_DUE",
          stripeSubscriptionId: "sub_p",
          graceUntil: future,
        },
        true,
        true,
      ],
      [
        {
          status: "PAST_DUE",
          stripeSubscriptionId: "sub_p2",
          graceUntil: past,
        },
        true,
        false,
      ],
      [
        {
          status: "CANCELED",
          stripeSubscriptionId: "sub_c1",
          paidThrough: future,
        },
        true,
        true,
      ],
      [
        {
          status: "CANCELED",
          stripeSubscriptionId: "sub_c2",
          paidThrough: past,
        },
        true,
        false,
      ],
    ] as const;
    for (const [data, stripeLinked, paidAccess] of cases) {
      const fixture = await workspace();
      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          planKey: "growth",
          interval: "MONTH",
          introOffer: true,
          ...data,
          stripeSubscriptionId:
            data.stripeSubscriptionId === null
              ? null
              : `${data.stripeSubscriptionId}_${randomUUID().slice(0, 8)}`,
        },
      });
      const overview = await getBillingOverview(fixture.workspaceId, now);
      expect(overview.subscription).toMatchObject({
        stripeLinked,
        paidAccess,
        introOffer: true,
      });
    }
  });

  it("tells a running free trial from one that has ended", async () => {
    const now = new Date();
    const cases = [
      ["running", new Date(now.getTime() + 3 * DAY_MS), true],
      ["over", new Date(now.getTime() - DAY_MS), false],
    ] as const;
    for (const [, trialEndsAt, trialActive] of cases) {
      const fixture = await workspace();
      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          status: "TRIALING",
          interval: "MONTH",
          quotaAnchor: new Date(trialEndsAt.getTime() - 7 * DAY_MS),
          trialEndsAt,
        },
      });

      const { subscription } = await getBillingOverview(
        fixture.workspaceId,
        now,
      );

      expect(subscription).toMatchObject({
        status: "TRIALING",
        planKey: null,
        trialActive,
        paidAccess: false,
        stripeLinked: false,
      });
      expect(subscription?.trialEndsAt).toBe(trialEndsAt.toISOString());
    }
  });

  it("a link from the other payment mode does not count as this mode's subscription", async () => {
    const now = new Date();
    const fixture = await workspace();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        paidThrough: new Date(now.getTime() + 10 * DAY_MS),
        stripeSubscriptionId: `sub_t_${randomUUID().slice(0, 8)}`,
        stripeLivemode: false,
      },
    });

    const asLive = await getBillingOverview(fixture.workspaceId, now, "live");
    const asTest = await getBillingOverview(fixture.workspaceId, now, "test");
    const unknown = await getBillingOverview(fixture.workspaceId, now);

    expect(asLive.subscription).toMatchObject({
      stripeLinked: false,
      paidAccess: false,
    });
    expect(asTest.subscription).toMatchObject({
      stripeLinked: true,
      paidAccess: true,
    });
    // Payments closed (no mode): any link counts, as before.
    expect(unknown.subscription?.stripeLinked).toBe(true);
  });

  it("a TEST-mode first-month discount is not the live key's: the screen offers it again, the same way the server decides", async () => {
    const now = new Date();
    const fixture = await workspace();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "CANCELED",
        paidThrough: new Date(now.getTime() - DAY_MS),
        stripeSubscriptionId: `sub_t_${randomUUID().slice(0, 8)}`,
        stripeLivemode: false,
        introOffer: true,
      },
    });

    const asLive = await getBillingOverview(fixture.workspaceId, now, "live");
    const asTest = await getBillingOverview(fixture.workspaceId, now, "test");

    expect(asLive.subscription).toMatchObject({
      stripeLinked: false,
      introOffer: false,
    });
    expect(asTest.subscription).toMatchObject({
      stripeLinked: true,
      introOffer: true,
    });
  });

  it("an old pack already used up does not inflate this window's bar", async () => {
    const fixture = await workspace();
    const now = new Date();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "growth",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: new Date(now.getTime() - 5 * DAY_MS),
        paidThrough: new Date(now.getTime() + 25 * DAY_MS),
      },
    });
    // Lifetime counters: 40 images bought over the months, all of them already used.
    await prisma.usageBalance.create({
      data: {
        id: randomUUID(),
        workspaceId: fixture.workspaceId,
        unit: "IMAGE",
        periodStart: new Date(now.getTime() - 5 * DAY_MS),
        periodEnd: new Date(now.getTime() + 25 * DAY_MS),
        periodGranted: B(50),
        periodUsed: B(10),
        extraGranted: B(40),
        extraUsed: B(40),
        updatedAt: now,
      },
    });

    const { allowances } = await getBillingOverview(fixture.workspaceId, now);

    // 10 of this window's 50 are spent: the bar says 20 %, not (10+40)/(50+40).
    expect(allowances[0]).toMatchObject({
      granted: 50,
      used: 10,
      available: 40,
      extraAvailable: 0,
    });
  });

  describe("what the end of an allowance window means", () => {
    // 100 images, 30 used in the current window, plus a 15-image pack that never expires.
    async function withWindow(
      row: {
        status: string;
        cancelAtPeriodEnd?: boolean;
        windowEnd: (now: Date) => Date;
      },
      now: Date,
    ) {
      const fixture = await workspace();
      await prisma.subscription.create({
        data: {
          workspaceId: fixture.workspaceId,
          planKey: "growth",
          interval: "MONTH",
          status: row.status,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false,
          quotaAnchor: new Date(now.getTime() - 20 * DAY_MS),
          paidThrough: row.windowEnd(now),
        },
      });
      await prisma.usageBalance.create({
        data: {
          id: randomUUID(),
          workspaceId: fixture.workspaceId,
          unit: "IMAGE",
          periodStart: new Date(now.getTime() - 20 * DAY_MS),
          periodEnd: row.windowEnd(now),
          periodGranted: B(100),
          periodUsed: B(30),
          extraGranted: B(15),
          extraUsed: B(0),
          updatedAt: now,
        },
      });
      return fixture;
    }
    const open = (now: Date) => new Date(now.getTime() + 10 * DAY_MS);
    const over = (now: Date) => new Date(now.getTime() - 2 * DAY_MS);

    it("an open window of a renewing plan renews; of a plan that is ending (or canceled with paid time left) it ends", async () => {
      const now = new Date();
      const renewing = await withWindow({ status: "ACTIVE", windowEnd: open }, now);
      const leaving = await withWindow(
        { status: "ACTIVE", cancelAtPeriodEnd: true, windowEnd: open },
        now,
      );
      const canceled = await withWindow(
        { status: "CANCELED", windowEnd: open },
        now,
      );

      const view = async (workspaceId: string) =>
        (await getBillingOverview(workspaceId, now, "test")).allowances[0];

      expect(await view(renewing.workspaceId)).toMatchObject({
        window: "renews",
        granted: 115,
        available: 85,
      });
      expect(await view(leaving.workspaceId)).toMatchObject({ window: "ends" });
      expect(await view(canceled.workspaceId)).toMatchObject({ window: "ends" });
    });

    it("a window that is over grants nothing: only the bought extra usage is shown, whatever the plan state", async () => {
      const now = new Date();
      const cases = [
        ["PAST_DUE", "overdue"],
        ["CANCELED", "ended"],
        ["ACTIVE", "renewing"],
      ] as const;
      for (const [status, window] of cases) {
        const fixture = await withWindow({ status, windowEnd: over }, now);

        const { allowances } = await getBillingOverview(
          fixture.workspaceId,
          now,
          "test",
        );

        // 70 of the closed window's 100 were never used and are NOT spendable any more: they
        // must not appear as "85 left of 115".
        expect(allowances[0], status).toMatchObject({
          window,
          granted: 15,
          used: 0,
          available: 15,
          extraAvailable: 15,
        });
      }
    });
  });

  it("an unknown plan key or a scheduled change reads safely", async () => {
    const fixture = await workspace();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "retired-plan",
        interval: "MONTH",
        status: "ACTIVE",
        pendingPlanKey: "starter",
        pendingInterval: "MONTH",
        pendingEffectiveAt: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    const overview = await getBillingOverview(fixture.workspaceId);
    expect(overview.subscription).toMatchObject({
      planKey: null,
      planLabel: null,
      interval: "MONTH",
      pending: {
        planKey: "starter",
        interval: "MONTH",
        effectiveAt: "2030-01-01T00:00:00.000Z",
      },
    });
  });

  it("counts this month's successful pictures and requests of THIS workspace only", async () => {
    const fixture = await workspace();
    const other = await workspace();
    const now = new Date();
    const thisMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12),
    );
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12),
    );

    await usage(fixture, { kind: "IMAGE", at: thisMonth });
    await usage(fixture, { kind: "IMAGE", units: 2, at: thisMonth });
    await usage(fixture, { kind: "IMAGE", module: "ADS", at: thisMonth });
    await usage(fixture, { kind: "TEXT", module: "CHAT", at: thisMonth });
    await usage(fixture, { kind: "SEARCH", module: "CHAT", at: thisMonth });
    await usage(fixture, { kind: "TEXT", module: "SEO", at: thisMonth });
    // None of these counts: a failed call, last month, another workspace.
    await usage(fixture, { kind: "IMAGE", success: false, at: thisMonth });
    await usage(fixture, { kind: "IMAGE", at: lastMonth });
    await usage(other, { kind: "IMAGE", at: thisMonth });
    await usage(other, { kind: "TEXT", at: thisMonth });

    const overview = await getBillingOverview(fixture.workspaceId, now);

    expect(overview.measured.images).toBe(4); // 1 + 2 + 1
    expect(overview.measured.aiRequests).toBe(3);
    expect(overview.measured.byModule).toEqual(
      expect.arrayContaining([
        { module: "SOCIAL", images: 3, aiRequests: 0 },
        { module: "ADS", images: 1, aiRequests: 0 },
        { module: "CHAT", images: 0, aiRequests: 2 },
        { module: "SEO", images: 0, aiRequests: 1 },
      ]),
    );
    expect(overview.measured.byModule).toHaveLength(4);
    // Busiest module first.
    expect(overview.measured.byModule[0]!.module).toBe("SOCIAL");
    // Today shows up in the daily history, with the same totals.
    const today = overview.measured.daily.find(
      (row) => row.day === thisMonth.toISOString().slice(0, 10),
    );
    expect(today).toEqual({
      day: thisMonth.toISOString().slice(0, 10),
      images: 4,
      aiRequests: 3,
    });
  });

  it("lists running work, work paused for the allowance (and why), and approvals waiting", async () => {
    const fixture = await workspace();
    const other = await workspace();
    await job(fixture, "QUEUED", { title: "Draft the newsletter" });
    await job(fixture, "WAITING_BUDGET", {
      title: "Weekend post",
      errorCode: "QUOTA_EXCEEDED",
    });
    await job(fixture, "WAITING_BUDGET", {
      title: "Story for Monday",
      errorCode: "NO_PLAN",
    });
    await job(other, "WAITING_BUDGET", {
      title: "Someone else's job",
      errorCode: "QUOTA_EXCEEDED",
    });
    const approvalTask = await job(fixture, "QUEUED", {
      title: "Publish to Instagram",
    });
    await prisma.approval.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        taskId: approvalTask.id,
        entityType: "Task",
        entityId: approvalTask.id,
        type: "GENERIC",
        status: "PENDING",
        requestedByType: "SYSTEM",
      },
    });

    const { tasks } = await getBillingOverview(fixture.workspaceId);

    expect(tasks.active.map((row) => row.title).sort()).toEqual([
      "Draft the newsletter",
      "Publish to Instagram",
    ]);
    expect(
      tasks.paused.map((row) => [row.title, row.pausedFor]).sort(),
    ).toEqual([
      ["Story for Monday", "no-plan"],
      ["Weekend post", "allowance"],
    ]);
    expect(tasks.awaitingApproval.map((row) => row.title)).toEqual([
      "Publish to Instagram",
    ]);
    // Every row names its brand so the page can link to it.
    for (const row of [...tasks.active, ...tasks.paused]) {
      expect(row.projectId).toBe(fixture.projectId);
      expect(row.projectName.length).toBeGreaterThan(0);
    }
    // Nothing waits for the automatic share: no share is named.
    expect(tasks).not.toHaveProperty("backgroundSharePct");
  });

  // Work the system started that ran into its own share of the plan is waiting,
  // but the allowance is not used up: the screen must not say it is (Faz 3C).
  it("tells work held back for the automatic share from work that ran out, and names the plan's share", async () => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
    const fixture = await workspace();
    const now = new Date();
    await prisma.subscription.create({
      data: {
        workspaceId: fixture.workspaceId,
        planKey: "starter",
        interval: "MONTH",
        status: "ACTIVE",
        quotaAnchor: new Date(now.getTime() - 5 * DAY_MS),
        paidThrough: new Date(now.getTime() + 25 * DAY_MS),
      },
    });
    await job(fixture, "WAITING_BUDGET", {
      title: "Weekly auto post",
      errorCode: "QUOTA_HELD_BACK",
    });
    await job(fixture, "WAITING_BUDGET", {
      title: "Weekend post",
      errorCode: "QUOTA_EXCEEDED",
    });

    const { tasks } = await getBillingOverview(fixture.workspaceId);

    expect(
      tasks.paused.map((row) => [row.title, row.pausedFor]).sort(),
    ).toEqual([
      ["Weekend post", "allowance"],
      ["Weekly auto post", "held-back"],
    ]);
    // Starter is a limited plan: automatic work may use 45% of it.
    expect(tasks.backgroundSharePct).toBe(45);
  });
});
