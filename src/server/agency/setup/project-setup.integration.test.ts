import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

process.env.AGENTELSE_REASONING_MODE = "mock";
process.env.AGENTELSE_PROVIDER_MODE = "mock";

import { prisma } from "@/lib/prisma";
import {
  createAgencyFixture,
  pumpWorker,
  teardownAgencyFixture,
  type AgencyFixture,
} from "@/server/agency/test-support/agency-fixtures";
import { ProjectSetupOrchestrator } from "@/server/agency/setup/project-setup-orchestrator";
import { describeIntegration } from "@/test-support/integration-suite";

// Wave 2 gate: setup stages 1-8 (INTAKE .. AUTONOMY_CONFIGURATION) complete
// end-to-end with mock reasoning + mock providers. Stages 9-12 get their
// engines in Wave 3; here they are pass-through and the whole pipeline
// should still walk to activation.
describeIntegration("Setup Mode — full 12-stage Biduniq scenario (spec test a)", () => {
  const runId = randomUUID().slice(0, 8);
  let fixture: AgencyFixture;

  beforeAll(async () => {
    fixture = await createAgencyFixture(runId);
    await ProjectSetupOrchestrator.start(fixture, {
      brandName: `TestBrand-${runId}`,
      domain: "testbrand.example",
      description:
        "Europe focused marketplace. We want growth, brand awareness, social, SEO and creative operations.",
      autoApprove: true,
    });
  }, 60_000);

  afterAll(async () => {
    await teardownAgencyFixture(fixture?.workspaceId);
  });

  it("walks all 12 stages to PROJECT_ACTIVATION and lands the project ACTIVE", async () => {
    const done = await pumpWorker(async () => {
      const state = await prisma.projectSetupState.findUnique({
        where: { projectId: fixture.projectId },
      });
      return state?.activatedAt !== null && state?.activatedAt !== undefined;
    }, 150);
    expect(done).toBe(true);

    const records = await prisma.projectSetupStageRecord.findMany({
      where: { projectId: fixture.projectId },
    });
    const byStage = new Map(records.map((r) => [r.stage, r.status]));
    for (const stage of [
      "INTAKE",
      "DEEP_DISCOVERY",
      "BRAND_CONSTITUTION",
      "SIGNAL_PROFILE",
      "BASELINE_AUDITS",
      "GOAL_GENERATION",
      "AGENCY_CONFIGURATION",
      "AUTONOMY_CONFIGURATION",
      "INITIAL_OPPORTUNITIES",
      "INITIAL_IDEA_PORTFOLIO",
      "INITIAL_WORK_PLAN",
      "PROJECT_ACTIVATION",
    ] as const) {
      expect(byStage.get(stage), `stage ${stage}`).toBe("COMPLETED");
    }

    const project = await prisma.project.findUnique({
      where: { id: fixture.projectId },
      select: { status: true },
    });
    expect(project?.status).toBe("ACTIVE");
  }, 600_000);

  it("produced goal-linked opportunities, multi-lens ideas with council evaluations, and director decisions", async () => {
    const insights = await prisma.insight.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(insights.length).toBeGreaterThanOrEqual(1);

    const opportunities = await prisma.opportunity.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(opportunities.length).toBeGreaterThanOrEqual(1);
    for (const opportunity of opportunities) {
      expect(
        opportunity.goalIds.length,
        `opportunity ${opportunity.title} must link a goal`,
      ).toBeGreaterThan(0);
      expect(opportunity.valueScore).not.toBeNull();
    }

    const ideas = await prisma.idea.findMany({
      where: { projectId: fixture.projectId },
      include: { councilEvaluations: true },
    });
    expect(ideas.length).toBeGreaterThanOrEqual(3);
    const lenses = new Set(ideas.map((i) => i.lens));
    expect(lenses.size).toBeGreaterThanOrEqual(2);
    const evaluated = ideas.filter((i) => i.councilEvaluations.length > 0);
    expect(evaluated.length).toBeGreaterThanOrEqual(3);

    const decisions = await prisma.agencyDecision.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(decisions.length).toBeGreaterThanOrEqual(1);

    // Director-created tasks must carry goal links + department + decision ref.
    const directorTasks = await prisma.task.findMany({
      where: {
        projectId: fixture.projectId,
        sourceDecisionId: { not: null },
      },
    });
    for (const task of directorTasks) {
      expect(task.goalIds.length).toBeGreaterThan(0);
      expect(task.departmentKey).not.toBeNull();
    }
  });

  it("ran deep discovery as real tasks that produced classified findings with evidence", async () => {
    const tasks = await prisma.task.findMany({
      where: { projectId: fixture.projectId, createdByType: "SYSTEM" },
    });
    const completed = tasks.filter((t) => t.status === "COMPLETED");
    expect(completed.length).toBeGreaterThanOrEqual(5);

    const findings = await prisma.finding.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(findings.length).toBeGreaterThanOrEqual(10);

    for (const finding of findings) {
      expect(finding.classification).toBeTruthy();
      if (finding.classification === "VERIFIED_FACT") {
        expect(
          finding.evidenceId,
          `VERIFIED_FACT ${finding.id} must carry evidence`,
        ).toBeTruthy();
      }
    }
    // Mock pipeline marks everything mock — nothing should masquerade as real.
    expect(findings.every((f) => f.isMock)).toBe(true);
  });

  it("synthesized an ACTIVE brand constitution derived from findings (not hardcoded)", async () => {
    const constitution = await prisma.brandConstitution.findFirst({
      where: { brandId: fixture.brandId, status: "ACTIVE" },
    });
    expect(constitution).toBeTruthy();
    expect(constitution?.version).toBe(1);
    expect(constitution?.isMock).toBe(true);

    const payload = constitution?.payload as Record<string, unknown>;
    // Derivation check: identity must reference the fixture's actual brand
    // name (mock builders derive from input, never canned strings).
    expect(String(payload.identity)).toContain(`TestBrand-${runId}`);
    expect(Array.isArray(payload.knownFacts)).toBe(true);
    expect((payload.knownFacts as unknown[]).length).toBeGreaterThan(0);
    expect(constitution?.sourceFindingIds.length).toBeGreaterThan(0);
  });

  it("configured 16 signal profiles and 19 departments", async () => {
    const profiles = await prisma.projectSignalProfile.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(profiles).toHaveLength(16);
    // Not everything may be VERY_HIGH — intensity must differentiate.
    const intensities = new Set(profiles.map((p) => p.intensity));
    expect(intensities.size).toBeGreaterThan(1);

    const departments = await prisma.projectDepartment.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(departments).toHaveLength(19);
    expect(departments.every((d) => d.recommendedMode !== null)).toBe(true);
  });

  it("produced baseline audits with scores and goal proposals approved by SYSTEM", async () => {
    const audits = await prisma.baselineAudit.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    for (const audit of audits) {
      expect(audit.score).toBeGreaterThanOrEqual(0);
      expect(audit.score).toBeLessThanOrEqual(100);
      expect(audit.summary.length).toBeGreaterThan(0);
    }

    const goals = await prisma.projectGoal.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(goals.length).toBeGreaterThanOrEqual(3);
    const active = goals.filter((g) => g.status === "ACTIVE");
    expect(active.length).toBeGreaterThanOrEqual(3);
    expect(active.every((g) => g.approvedByType === "SYSTEM")).toBe(true);
  });

  it("audited every reasoning call with budget tracking", async () => {
    const calls = await prisma.reasoningCall.findMany({
      where: { projectId: fixture.projectId },
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.isMock)).toBe(true);

    const stat = await prisma.agencyDailyStat.findFirst({
      where: { projectId: fixture.projectId },
    });
    expect(stat?.reasoningCalls).toBeGreaterThan(0);
  });
});
