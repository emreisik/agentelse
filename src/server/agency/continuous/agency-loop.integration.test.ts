import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

process.env.AGENTELSE_REASONING_MODE = "mock";
process.env.AGENTELSE_PROVIDER_MODE = "mock";

import { prisma } from "@/lib/prisma";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { WorkHandoffEngine } from "@/server/agency/handoffs/work-handoff-engine";
import { TaskPlanner } from "@/server/commands/task-planner";
import { ApprovalRepository } from "@/server/repositories/approval.repository";

import {
  createActiveAgencyFixture,
  pumpWorker,
  teardownAgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { describeIntegration } from "@/test-support/integration-suite";

// Spec test (b): a simulated "new technology product launch" signal walks
// Signal -> Intelligence -> relevance -> Opportunity -> Idea Foundry (multi
// concepts) -> Council -> Agency Director -> plan -> department tasks.
//
// Everything up to an EVALUATED opportunity, and everything from a RAW idea on
// (Council, Director, plan), is driven by the worker tick. Turning an EVALUATED
// opportunity into ideas is NOT: it stopped being a tick step in d5eddbf and is
// on demand only (a chat request, command-service.ts
// GENERATE_IDEAS_FROM_OPPORTUNITIES), so the test makes that same call itself.
describeIntegration(
  "Continuous loop — signal to work plan (spec test b)",
  () => {
    const runId = randomUUID().slice(0, 8);
    let fixture: Awaited<ReturnType<typeof createActiveAgencyFixture>>;

    beforeAll(async () => {
      fixture = await createActiveAgencyFixture(runId);
      const result = await SignalUniverse.ingestRaw({
        ...fixture,
        source: "test-feed",
        category: "PRODUCT_LAUNCH",
        externalRef: `launch-${runId}`,
        title: "Major competitor launches new technology product",
        summary:
          "A major consumer technology product launch is drawing marketplace attention across Europe",
      });
      expect(result.duplicate).toBe(false);
    }, 60_000);

    afterAll(async () => {
      await teardownAgencyFixture(fixture?.workspaceId);
    });

    it("dedupes an identical raw signal", async () => {
      const dup = await SignalUniverse.ingestRaw({
        ...fixture,
        source: "test-feed",
        category: "PRODUCT_LAUNCH",
        externalRef: `launch-${runId}`,
        title: "Major competitor launches new technology product (repost)",
      });
      expect(dup.duplicate).toBe(true);
      const count = await prisma.signal.count({
        where: { projectId: fixture.projectId },
      });
      expect(count).toBe(1);
    });

    it("walks the signal through intelligence to an agency decision with work", async () => {
      // The worker brings the signal to an EVALUATED opportunity on its own...
      const evaluated = await pumpWorker(
        async () =>
          (await prisma.opportunity.count({
            where: { projectId: fixture.projectId, status: "EVALUATED" },
          })) > 0,
        60,
      );
      expect(evaluated).toBe(true);

      // ...and turning it into ideas is the on-demand step: the same call a chat
      // request ("give me some new ideas") makes. The mock lens concepts give a
      // multi-concept set (>= 3 ideas across >= 3 lenses).
      const generated = await IdeaFoundry.generateForTopOpportunities(5, {
        projectId: fixture.projectId,
      });
      expect(generated).toBeGreaterThanOrEqual(3);

      const done = await pumpWorker(async () => {
        const decision = await prisma.agencyDecision.findFirst({
          where: {
            projectId: fixture.projectId,
            decision: {
              in: [
                "CREATE_TASK",
                "CREATE_CAMPAIGN",
                "CREATE_MULTI_DEPARTMENT_PLAN",
              ],
            },
          },
        });
        if (!decision) return false;

        // A decision on the first council-evaluated idea can land well before
        // its sibling lens-ideas get their turn: council-evaluation pulls RAW
        // ideas via listByStatus, which caps each tick to one idea PER PROJECT
        // (distinct: ["projectId"], see idea.repository.ts) so one very active
        // project can never starve every other project's backlog. With only
        // one project in this fixture, that fairness cap means its 3+ sibling
        // ideas clear the council one per tick — so wait for all of them
        // before checking below, instead of stopping at the first decision.
        const evaluatedCount = await prisma.idea.count({
          where: {
            projectId: fixture.projectId,
            councilEvaluations: { some: {} },
          },
        });
        return evaluatedCount >= 3;
      }, 60);
      expect(done).toBe(true);

      const signal = await prisma.signal.findFirst({
        where: { projectId: fixture.projectId },
      });
      expect(signal?.status).toBe("PROMOTED");
      expect(signal?.relevanceScore).not.toBeNull();

      const insight = await prisma.insight.findFirst({
        where: { projectId: fixture.projectId },
      });
      expect(insight).toBeTruthy();

      const opportunity = await prisma.opportunity.findFirst({
        where: { projectId: fixture.projectId },
      });
      expect(opportunity).toBeTruthy();
      expect(opportunity?.goalIds.length).toBeGreaterThan(0);
      expect(opportunity?.valueScore).not.toBeNull();
      expect(opportunity?.nbaScore ?? opportunity?.valueScore).not.toBeNull();

      const ideas = await prisma.idea.findMany({
        where: { projectId: fixture.projectId },
        include: { councilEvaluations: true },
      });
      expect(ideas.length).toBeGreaterThanOrEqual(3);
      const lenses = new Set(ideas.map((i) => i.lens));
      expect(lenses.size).toBeGreaterThanOrEqual(3);
      const withCouncil = ideas.filter((i) => i.councilEvaluations.length > 0);
      expect(withCouncil.length).toBeGreaterThanOrEqual(3);
    }, 400_000);

    it("multi-department decisions produce a dependency-wired work plan", async () => {
      // İşçi iki şeritli: plan görevleri karardan sonraki turlarda yazılır; en
      // az üç görev görünene kadar tur at (tek findFirst turdan önce 2 görev görür).
      const loadPlan = () =>
        prisma.workPlan.findFirst({
          where: { projectId: fixture.projectId },
          orderBy: { createdAt: "asc" },
          include: { tasks: true },
        });
      await pumpWorker(async () => ((await loadPlan())?.tasks.length ?? 0) >= 3, 30);
      const plan = await loadPlan();
      // At least one decided idea should have gone the multi-department path
      // (mock lens concepts always involve >=2 departments).
      expect(plan).toBeTruthy();
      expect(plan?.tasks.length).toBeGreaterThanOrEqual(3);

      const departments = new Set(plan?.tasks.map((t) => t.departmentKey));
      expect(departments.size).toBeGreaterThanOrEqual(2);

      const deps = await prisma.taskDependency.findMany({
        where: { task: { workPlanId: plan?.id } },
      });
      expect(deps.length).toBeGreaterThanOrEqual(2);

      // Every plan task carries goals (autonomous work must serve a goal).
      for (const task of plan?.tasks ?? []) {
        expect(task.goalIds.length).toBeGreaterThan(0);
      }
    });

    it("parks externally visible plan nodes behind leveled approvals", async () => {
      const approvals = await prisma.approval.findMany({
        where: { projectId: fixture.projectId, status: "PENDING" },
      });
      // PR/web nodes (if generated) must carry LEVEL_3+; there may be none if
      // no external node was in the winning plans — so only assert on found
      // rows. `level: null` is schema.prisma's documented "legacy row,
      // treated as LEVEL_3_CLIENT" (see the Approval model) — a valid value
      // here, not a missing one.
      for (const approval of approvals) {
        if (approval.level === null) continue;
        expect(["LEVEL_3_CLIENT", "LEVEL_4_CRITICAL"]).toContain(
          approval.level,
        );
      }
    });
  },
);

// Spec test (c): SEO content-gap finding -> content task -> completed ->
// WorkHandoff to WEB_PRODUCT -> approval -> deploy -> verify -> measure ->
// learning.
describeIntegration("SEO handoff chain (spec test c)", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: Awaited<ReturnType<typeof createActiveAgencyFixture>>;
  let contentTaskId: string;
  let handoffId: string;
  let deployTaskId: string;

  beforeAll(async () => {
    fixture = await createActiveAgencyFixture(runId);

    // The SEO department surfaces a content gap as a Finding (this is what a
    // real SEO_ANALYSIS task's materialization would produce).
    await prisma.finding.create({
      data: {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        sourceType: "RESEARCH_TASK",
        category: "seo",
        statement: `Content gap: no landing page for "smart home devices" intent (${runId})`,
        classification: "LIKELY_FACT",
        confidence: 0.8,
        isMock: true,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("creates and completes the content task", async () => {
    const planned = await TaskPlanner.planForCapability({
      ...fixture,
      capability: "CREATE_COPY",
      request: `Landing page content for smart home devices gap (${runId})`,
      createdByType: "SYSTEM",
      departmentKey: "COPY_CONTENT",
      goalIds: [fixture.goalIds[1] ?? fixture.goalIds[0] ?? ""],
    });
    contentTaskId = planned.task.id;
    expect(planned.dispatched).toBe(true);

    const done = await pumpWorker(async () => {
      const task = await prisma.task.findUnique({
        where: { id: contentTaskId },
      });
      return task?.status === "COMPLETED";
    }, 40);
    if (!done) {
      const task = await prisma.task.findUnique({
        where: { id: contentTaskId },
      });
      const jobs = await prisma.executionJob.findMany({
        where: { taskId: contentTaskId },
      });
      const outbox = await prisma.outboxEvent.findMany({
        where: { aggregateId: { in: jobs.map((j) => j.id) } },
      });
      const dl = await prisma.deadLetterJob.findMany({
        where: { executionJobId: { in: jobs.map((j) => j.id) } },
      });
      console.error("DIAG task:", JSON.stringify(task));
      console.error("DIAG jobs:", JSON.stringify(jobs));
      console.error("DIAG outbox:", JSON.stringify(outbox));
      console.error("DIAG deadletters:", JSON.stringify(dl));
    }
    expect(done).toBe(true);
  }, 120_000);

  it("hands the approved content off to WEB_PRODUCT with a leveled approval", async () => {
    const handoff = await WorkHandoffEngine.propose({
      ...fixture,
      fromDepartment: "COPY_CONTENT",
      toDepartment: "WEB_PRODUCT",
      fromTaskId: contentTaskId,
      reason: "Approved content ready for landing page deployment",
      payload: { contentTaskId },
    });
    handoffId = handoff.id;
    expect(handoff.status).toBe("PROPOSED");

    const accepted = await WorkHandoffEngine.accept(
      handoffId,
      fixture.projectId,
      {
        capability: "WEBSITE_UPDATE",
        request: `Deploy smart home devices landing page (${runId})`,
        goalIds: [fixture.goalIds[1] ?? fixture.goalIds[0] ?? ""],
      },
    );
    expect(accepted).toBeTruthy();
    deployTaskId = accepted!.task.id;

    // WEBSITE_UPDATE is externally visible: parked at LEVEL_3 approval.
    const task = await prisma.task.findUnique({ where: { id: deployTaskId } });
    expect(task?.status).toBe("WAITING_APPROVAL");

    const approval = await prisma.approval.findFirst({
      where: { taskId: deployTaskId, status: "PENDING" },
    });
    expect(approval).toBeTruthy();
    expect(approval?.level).toBe("LEVEL_3_CLIENT");

    const stored = await prisma.workHandoff.findUnique({
      where: { id: handoffId },
    });
    expect(stored?.status).toBe("TASK_CREATED");
    expect(stored?.toTaskId).toBe(deployTaskId);
  });

  it("deploys after approval, verifies with evidence, and completes the handoff", async () => {
    const approval = await prisma.approval.findFirst({
      where: { taskId: deployTaskId, status: "PENDING" },
    });
    await ApprovalRepository.decide(
      approval!.id,
      fixture.projectId,
      "APPROVED",
      "test-user",
      "test approval",
    );
    await TaskPlanner.dispatchApprovedTask(deployTaskId, fixture.projectId);

    const done = await pumpWorker(async () => {
      const task = await prisma.task.findUnique({
        where: { id: deployTaskId },
      });
      return task?.status === "COMPLETED";
    }, 40);
    expect(done).toBe(true);

    // Verification (not just provider success): VERIFIED with evidence.
    const job = await prisma.executionJob.findFirst({
      where: { taskId: deployTaskId },
      include: { verification: true },
    });
    expect(job?.verification?.status).toBe("VERIFIED");
    expect(job?.verification?.evidenceIds.length).toBeGreaterThan(0);

    // The worker's two lanes run side by side (execution-worker.ts tickFast /
    // tickSlow): the agency step sees the finished task on the NEXT tick, not
    // in the tick that verified it, so the handoff completes a tick later.
    const handoffDone = await pumpWorker(async () => {
      const handoff = await prisma.workHandoff.findUnique({
        where: { id: handoffId },
      });
      return handoff?.status === "COMPLETED";
    }, 10);
    expect(handoffDone).toBe(true);
  }, 180_000);

  it("schedules measurement, runs the due check, and extracts a learning", async () => {
    // Deploy completion must have created the WEBSITE_UPDATE measurement plan.
    const plan = await prisma.measurementPlan.findFirst({
      where: { taskId: deployTaskId },
      include: { checks: true },
    });
    expect(plan).toBeTruthy();
    expect(plan?.checks.length).toBeGreaterThanOrEqual(3);
    expect(plan?.checks.map((c) => c.label)).toContain("indexing check");

    // Force the first check due now, pump the loop.
    const first = plan!.checks[0]!;
    await prisma.measurementCheck.update({
      where: { id: first.id },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
    // Others stay future-dated; skip them so the plan can complete.
    for (const check of plan!.checks.slice(1)) {
      await prisma.measurementCheck.update({
        where: { id: check.id },
        data: { status: "SKIPPED" },
      });
    }

    const measured = await pumpWorker(async () => {
      const learning = await prisma.brandLearning.findFirst({
        where: { projectId: fixture.projectId, sourceRef: plan!.id },
      });
      return Boolean(learning);
    }, 50);
    expect(measured).toBe(true);

    const check = await prisma.measurementCheck.findUnique({
      where: { id: first.id },
    });
    expect(check?.status).toBe("COMPLETED");
    expect(check?.resultSummary).toBeTruthy();

    const completedPlan = await prisma.measurementPlan.findUnique({
      where: { id: plan!.id },
    });
    expect(completedPlan?.status).toBe("COMPLETED");

    const learning = await prisma.brandLearning.findFirst({
      where: { projectId: fixture.projectId, sourceRef: plan!.id },
    });
    expect(learning?.insight).toContain("[MOCK]");
    expect(learning?.sourceType).toBe("MEASUREMENT_PLAN");
  }, 240_000);
});
