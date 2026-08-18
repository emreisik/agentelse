import { prisma } from "@/lib/prisma";
import { ExecutionWorker } from "@/server/workers/execution-worker";

// Shared integration-test helpers for the Agency OS scenarios. Follows the
// house pattern: runId-namespaced fixtures, FK-safe teardown by workspaceId.

export type AgencyFixture = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export async function createAgencyFixture(
  runId: string,
): Promise<AgencyFixture> {
  return prisma.$transaction(async (transaction) => {
    const workspace = await transaction.workspace.create({
      data: { name: `Agency Test ${runId}`, slug: `agency-test-${runId}` },
    });
    const project = await transaction.project.create({
      data: {
        workspaceId: workspace.id,
        name: `Agency Project ${runId}`,
        slug: `agency-project-${runId}`,
        brands: {
          create: {
            workspaceId: workspace.id,
            name: `Agency Brand ${runId}`,
            slug: "default",
            isDefault: true,
          },
        },
      },
      include: { brands: true },
    });
    const brand = project.brands[0];
    if (!brand) throw new Error("fixture brand missing");
    return {
      workspaceId: workspace.id,
      projectId: project.id,
      brandId: brand.id,
    };
  });
}

// Repeatedly runs the worker tick until `until` returns true (or maxTicks is
// exhausted). Mirrors production: dev instrumentation calls tick() on an
// interval; here we pump it synchronously.
export async function pumpWorker(
  until: () => Promise<boolean>,
  maxTicks = 40,
): Promise<boolean> {
  if (await until()) return true;
  for (let i = 0; i < maxTicks; i += 1) {
    await ExecutionWorker.tick();
    if (await until()) return true;
  }
  return until();
}

// FK-safe teardown: delete children before parents. Everything is
// workspace-scoped, so one workspaceId wipes the whole fixture.
export async function teardownAgencyFixture(
  workspaceId?: string,
): Promise<void> {
  if (!workspaceId) return;

  const where = { workspaceId };
  await prisma.reasoningCall.deleteMany({ where });
  await prisma.agencyDailyStat.deleteMany({ where });
  await prisma.agencyTrigger.deleteMany({ where });
  await prisma.measurementCheck.deleteMany({ where });
  await prisma.measurementPlan.deleteMany({ where });
  await prisma.workHandoff.deleteMany({ where });
  await prisma.councilEvaluation.deleteMany({ where });
  await prisma.idea.deleteMany({ where });
  await prisma.agencyDecision.deleteMany({ where });
  await prisma.opportunity.deleteMany({ where });
  await prisma.insight.deleteMany({ where });
  await prisma.signal.deleteMany({ where });
  await prisma.finding.deleteMany({ where });
  await prisma.baselineAudit.deleteMany({ where });
  await prisma.projectGoal.deleteMany({ where });
  await prisma.projectDepartment.deleteMany({ where });
  await prisma.projectSignalProfile.deleteMany({ where });
  await prisma.brandConstitution.deleteMany({ where });
  await prisma.projectSetupStageRecord.deleteMany({ where });
  await prisma.projectSetupState.deleteMany({ where });
  await prisma.autonomyPolicy.deleteMany({ where });
  await prisma.executionVerification.deleteMany({ where });
  await prisma.evidence.deleteMany({ where });
  await prisma.creativeVersion.deleteMany({
    where: { creative: { workspaceId } },
  });
  await prisma.creative.deleteMany({ where });
  await prisma.approval.deleteMany({ where });
  await prisma.humanInterventionRequest.deleteMany({ where });
  await prisma.outboxEvent.deleteMany({
    where: { executionJob: { workspaceId } },
  });
  await prisma.deadLetterJob.deleteMany({
    where: { executionJob: { workspaceId } },
  });
  await prisma.executionContextSnapshot.deleteMany({ where });
  await prisma.executionJob.deleteMany({ where });
  await prisma.workPlan.deleteMany({ where });
  await prisma.taskDependency.deleteMany({ where: { task: { workspaceId } } });
  await prisma.task.deleteMany({ where });
  await prisma.command.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where });
  await prisma.asset.deleteMany({ where });
  await prisma.browserProfile.deleteMany({ where });
  await prisma.brandDossier.deleteMany({ where });
  await prisma.brand.deleteMany({ where });
  await prisma.project.deleteMany({ where });
  await prisma.workspaceMember.deleteMany({ where });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
}

// Fast fixture: an ACTIVE project with constitution/goals/departments/policy
// already in place — for continuous-loop tests that must not pay the full
// 12-stage setup wall-clock cost.
export async function createActiveAgencyFixture(
  runId: string,
): Promise<AgencyFixture & { goalIds: string[] }> {
  const fixture = await createAgencyFixture(runId);

  try {
    return await populateActiveAgencyFixture(fixture, runId);
  } catch (error) {
    // The caller never receives `fixture` when population fails, so clean it
    // here. Preserve the setup error even if best-effort cleanup also fails.
    await teardownAgencyFixture(fixture.workspaceId).catch(() => undefined);
    throw error;
  }
}

async function populateActiveAgencyFixture(
  fixture: AgencyFixture,
  runId: string,
): Promise<AgencyFixture & { goalIds: string[] }> {

  await prisma.project.update({
    where: { id: fixture.projectId },
    data: { status: "ACTIVE" },
  });

  await prisma.autonomyPolicy.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      setupAutoApprove: true,
      maxReasoningCallsPerDay: 500,
    },
  });

  await prisma.browserProfile.createMany({
    data: (
      ["PUBLIC_RESEARCH", "INSTAGRAM", "LINKEDIN"] as const
    ).map((purpose) => ({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      name: `fixture-${runId}-${purpose.toLowerCase()}`,
      slug: `fixture-${runId}-${purpose.toLowerCase()}`,
      purpose,
      status: "READY" as const,
    })),
  });

  await prisma.brandConstitution.create({
    data: {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      version: 1,
      status: "ACTIVE",
      payload: {
        identity: `Fixture brand ${runId} — technology marketplace`,
        businessModel: "Online marketplace",
        products: ["consumer electronics"],
        markets: ["Europe"],
        audiences: ["tech-savvy consumers"],
        positioning: "curated technology marketplace",
        valueProposition: "trusted technology deals",
        personality: "sharp",
        toneOfVoice: "confident",
        visualIdentity: "clean",
        logoAssetIds: [],
        approvedClaims: [],
        forbiddenClaims: [],
        negativeBrief: [],
        customerProblems: [],
        customerObjections: [],
        competitors: [],
        differentiators: [],
        legalRestrictions: [],
        knownFacts: [`fixture ${runId} known fact`],
        assumptions: [],
        openQuestions: [],
      },
      summary: `Fixture constitution ${runId}`,
      isMock: true,
    },
  });

  const goals = await prisma.projectGoal.createManyAndReturn({
    data: [
      {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Increase brand awareness",
        metricKey: "brand_awareness",
        priority: 1,
        status: "ACTIVE",
        approvedByType: "SYSTEM",
        isMock: true,
      },
      {
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        brandId: fixture.brandId,
        title: "Increase organic traffic",
        metricKey: "organic_traffic",
        priority: 2,
        status: "ACTIVE",
        approvedByType: "SYSTEM",
        isMock: true,
      },
    ],
  });

  const departments = [
    "BRAND_STRATEGY",
    "MARKET_INTELLIGENCE",
    "COMPETITOR_INTELLIGENCE",
    "CREATIVE",
    "COPY_CONTENT",
    "SOCIAL_MEDIA",
    "SEO",
    "WEB_PRODUCT",
    "PR_MEDIA",
    "DATA_ANALYTICS",
  ] as const;
  await prisma.projectDepartment.createMany({
    data: departments.map((department) => ({
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      brandId: fixture.brandId,
      department,
      mode: "EXECUTE" as const,
    })),
  });

  return { ...fixture, goalIds: goals.map((g) => g.id) };
}
