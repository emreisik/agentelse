import { randomUUID } from "node:crypto";

import { afterAll, afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const config = vi.hoisted(() => ({
  current: {
    mode: "enforce" as "off" | "shadow" | "enforce",
    legacyBefore: null as Date | null,
    legacyUntil: null as Date | null,
  },
}));
vi.mock("@/server/billing/config", () => ({
  getBillingConfig: () => config.current,
}));

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

import { WorkPlanProgressor } from "./work-plan-progressor";

// A plan node is judged again when its dependencies are done (Faz 3C): the stored
// flag is only what was true at creation, and the cost approval depends on things
// that change while a node waits (billing mode, plan, the size the person allows).
// The real planner, the real policy and a real database; the node carries the
// payload that sizes it (3 pictures cost more than Growth's size of $1).

const runId = randomUUID().slice(0, 8);
const fixtures: AgencyFixture[] = [];

const THREE_PICTURES = { request: "A launch post", variantCount: 3 };
const ONE_PICTURE = { request: "A launch post" };

async function workspace(options: { approveAboveUsd?: number } = {}) {
  const fixture = await createAgencyFixture(`wpa-${runId}-${fixtures.length}`);
  fixtures.push(fixture);
  await prisma.subscription.create({
    data: {
      workspaceId: fixture.workspaceId,
      planKey: "growth",
      interval: "MONTH",
      status: "ACTIVE",
      quotaAnchor: new Date(Date.now() - 24 * 60 * 60 * 1000),
      paidThrough: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.autonomyPolicy.upsert({
    where: { projectId: fixture.projectId },
    create: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      approveAboveUsd: options.approveAboveUsd ?? null,
    },
    update: { approveAboveUsd: options.approveAboveUsd ?? null },
  });
  return fixture;
}

// A ready node of a running plan, made by the system.
async function readyNode(
  fixture: AgencyFixture,
  node: {
    payload: Record<string, unknown>;
    requiresApproval: boolean;
    capability?: "CREATE_SOCIAL_CREATIVE" | "TIKTOK_PUBLISH";
  },
) {
  const plan = await prisma.workPlan.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      title: "Launch",
      planType: "CAMPAIGN",
      status: "IN_PROGRESS",
      graph: [],
    },
  });
  const task = await prisma.task.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      workPlanId: plan.id,
      title: "A launch post",
      capability: node.capability ?? "CREATE_SOCIAL_CREATIVE",
      status: "READY",
      riskLevel: "LOW",
      createdByType: "SYSTEM",
      requiresApproval: node.requiresApproval,
      payload: node.payload as never,
    },
  });
  return { plan, task };
}

async function afterDispatch(fixture: AgencyFixture, plan: { id: string }) {
  const dispatched = await WorkPlanProgressor.dispatchReadyTasks(
    plan.id,
    fixture.projectId,
  );
  return dispatched;
}

const taskOf = (id: string) => prisma.task.findUniqueOrThrow({ where: { id } });
const approvalsOf = (taskId: string) =>
  prisma.approval.findMany({ where: { taskId } });
const jobsOf = (taskId: string) =>
  prisma.executionJob.findMany({ where: { taskId } });

// The approval card the chat shows for the task, with the reason it carries.
async function cardOf(fixture: AgencyFixture, taskId: string) {
  const commands = await prisma.command.findMany({
    where: { projectId: fixture.projectId, source: "SYSTEM" },
  });
  for (const command of commands) {
    const card = (command.parsedIntent as { card?: Record<string, unknown> })
      ?.card;
    if (card?.kind === "approval-request" && card.taskId === taskId) {
      return card as { details?: Array<{ label: string; value: string }> };
    }
  }
  return undefined;
}

describeIntegration("dispatchReadyTasks and the cost approval", () => {
  afterEach(() => {
    config.current = { mode: "enforce", legacyBefore: null, legacyUntil: null };
  });

  afterAll(async () => {
    for (const fixture of fixtures.splice(0)) {
      await teardownAgencyFixture(fixture.workspaceId);
    }
  });

  it("asks about a node that was made before it was costly enough to ask, sized with its own payload", async () => {
    const fixture = await workspace();
    const { plan, task } = await readyNode(fixture, {
      payload: THREE_PICTURES,
      requiresApproval: false, // made while billing was not enforcing
    });

    expect(await afterDispatch(fixture, plan)).toBe(1);

    expect(await taskOf(task.id)).toMatchObject({
      status: "WAITING_APPROVAL",
      requiresApproval: true,
    });
    expect(await jobsOf(task.id)).toEqual([]);
    const [approval, ...rest] = await approvalsOf(task.id);
    expect(rest).toEqual([]);
    expect(approval).toMatchObject({
      level: "LEVEL_3_CLIENT",
      status: "PENDING",
    });
    const card = await cardOf(fixture, task.id);
    expect(card?.details).toEqual([
      {
        label: "Why you are asked",
        value: expect.stringContaining("3 post images"),
      },
    ]);
  });

  it("sizes a node that was flagged at creation with its payload, not as a single picture", async () => {
    const fixture = await workspace();
    const { plan, task } = await readyNode(fixture, {
      payload: THREE_PICTURES,
      requiresApproval: true,
    });

    await afterDispatch(fixture, plan);

    // Sized as one picture it would have been asked about at a level that does not
    // block, with no reason on the card.
    const [approval] = await approvalsOf(task.id);
    expect(approval).toMatchObject({ level: "LEVEL_3_CLIENT" });
    expect((await cardOf(fixture, task.id))?.details).toEqual([
      {
        label: "Why you are asked",
        value: expect.stringContaining("3 post images"),
      },
    ]);
  });

  it("lets a node go that the person has since made room for, and drops its flag", async () => {
    // The node was flagged when Growth's size ($1) was in force; the person has
    // raised it to $2.50 since.
    const fixture = await workspace({ approveAboveUsd: 2.5 });
    const { plan, task } = await readyNode(fixture, {
      payload: THREE_PICTURES,
      requiresApproval: true,
    });

    await afterDispatch(fixture, plan);

    expect(await taskOf(task.id)).toMatchObject({
      status: "QUEUED",
      requiresApproval: false,
    });
    expect(await approvalsOf(task.id)).toEqual([]);
    expect(await jobsOf(task.id)).toHaveLength(1);
  });

  it("sends a single-picture node straight on, as before", async () => {
    const fixture = await workspace();
    const { plan, task } = await readyNode(fixture, {
      payload: ONE_PICTURE,
      requiresApproval: false,
    });

    await afterDispatch(fixture, plan);

    expect(await taskOf(task.id)).toMatchObject({
      status: "QUEUED",
      requiresApproval: false,
    });
    expect(await approvalsOf(task.id)).toEqual([]);
    expect(await jobsOf(task.id)).toHaveLength(1);
  });

  it("does not touch the stored flag when the answer is the same", async () => {
    const fixture = await workspace();
    const { plan, task } = await readyNode(fixture, {
      payload: THREE_PICTURES,
      requiresApproval: true,
    });
    const before = await taskOf(task.id);

    await afterDispatch(fixture, plan);

    // Only the status moved: the flag was already right, no extra write.
    const after = await taskOf(task.id);
    expect(after.requiresApproval).toBe(true);
    expect(after.status).toBe("WAITING_APPROVAL");
    expect(before.requiresApproval).toBe(true);
  });

  it("when billing is not enforcing, a node that only waited for its cost goes straight on", async () => {
    config.current = { mode: "shadow", legacyBefore: null, legacyUntil: null };
    const fixture = await workspace();
    const { plan, task } = await readyNode(fixture, {
      payload: THREE_PICTURES,
      requiresApproval: true,
    });

    await afterDispatch(fixture, plan);

    expect(await taskOf(task.id)).toMatchObject({
      status: "QUEUED",
      requiresApproval: false,
    });
    expect(await approvalsOf(task.id)).toEqual([]);
  });

  it("a node the capability itself asks about is asked about whatever the cost", async () => {
    const fixture = await workspace({ approveAboveUsd: 5 });
    const { plan, task } = await readyNode(fixture, {
      capability: "TIKTOK_PUBLISH",
      payload: ONE_PICTURE,
      requiresApproval: false,
    });

    await afterDispatch(fixture, plan);

    expect(await taskOf(task.id)).toMatchObject({
      status: "WAITING_APPROVAL",
      requiresApproval: true,
    });
    const [approval] = await approvalsOf(task.id);
    expect(approval).toMatchObject({ level: "LEVEL_3_CLIENT" });
  });
});
