// Dev helper: runs the full 12-stage Agency OS setup against a seeded demo
// project with mock reasoning + mock providers, so the UI has a complete
// dataset (constitution, signals, audits, goals, opportunities, ideas,
// council evaluations, work plans, decisions) to render.
//
//   npm run db:seed:agency            -> Biduniq, auto-approve (full walk)
//   npm run db:seed:agency -- --manual -> BityPay, manual decisions
//                                        (WAITING_CLIENT decision UI testing)

// Order matters: .env is loaded FIRST, mock flags are written SECOND.
// Otherwise the real settings in .env override the mocks and the script
// hits the live Anthropic API.
process.loadEnvFile(".env");
process.env.AGENTELSE_REASONING_MODE = "mock";
process.env.AGENTELSE_PROVIDER_MODE = "mock";

// "server-only" throws outside Next's bundler — pre-populate the CJS require
// cache with an empty module so app imports load under tsx (same effect as
// vitest.setup.ts's vi.mock, but for a plain script).
import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
const serverOnlyPath = nodeRequire.resolve("server-only");
nodeRequire.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as never;

async function main() {
  const { prisma } = await import("../src/lib/prisma");
  const { ProjectSetupOrchestrator } =
    await import("../src/server/agency/setup/project-setup-orchestrator");
  const { ExecutionWorker } =
    await import("../src/server/workers/execution-worker");

  const manual = process.argv.includes("--manual");
  const slug = manual ? "bitypay" : "biduniq";

  const project = await prisma.project.findFirst({
    where: { slug },
    include: { brands: { where: { isDefault: true } } },
  });
  if (!project || !project.brands[0]) {
    console.error(`Project not found: ${slug}. Run \`npm run db:seed\` first.`);
    process.exitCode = 1;
    return;
  }
  const brand = project.brands[0];

  if (process.argv.includes("--reset")) {
    const where = { projectId: project.id };
    // Order: leaf tables first, root table last.
    await prisma.measurementCheck.deleteMany({
      where: { plan: { projectId: project.id } },
    });
    await prisma.measurementPlan.deleteMany({ where });
    await prisma.workHandoff.deleteMany({ where });
    // If pending outbox events in the queue point to deleted jobs, the
    // worker tries to write them to the dead letter table and hits an FK
    // violation.
    await prisma.outboxEvent.deleteMany({ where });
    await prisma.deadLetterJob.deleteMany({
      where: { executionJob: { projectId: project.id } },
    });
    await prisma.executionJob.deleteMany({ where });
    await prisma.approval.deleteMany({
      where: { task: { projectId: project.id, createdByType: "SYSTEM" } },
    });
    await prisma.taskDependency.deleteMany({
      where: { task: { projectId: project.id, createdByType: "SYSTEM" } },
    });
    await prisma.humanInterventionRequest.deleteMany({ where });
    await prisma.task.deleteMany({
      where: { projectId: project.id, createdByType: "SYSTEM" },
    });
    await prisma.workPlan.deleteMany({ where });
    await prisma.councilEvaluation.deleteMany({ where });
    await prisma.idea.deleteMany({ where });
    await prisma.opportunity.deleteMany({ where });
    await prisma.insight.deleteMany({ where });
    await prisma.finding.deleteMany({ where });
    await prisma.signal.deleteMany({ where });
    await prisma.projectSignalProfile.deleteMany({ where });
    await prisma.baselineAudit.deleteMany({ where });
    await prisma.projectGoal.deleteMany({ where });
    await prisma.agencyDecision.deleteMany({ where });
    await prisma.agencyTrigger.deleteMany({ where });
    await prisma.agencyDailyStat.deleteMany({ where });
    await prisma.reasoningCall.deleteMany({ where });
    await prisma.projectDepartment.deleteMany({ where });
    await prisma.brandConstitution.deleteMany({ where });
    await prisma.projectSetupState.deleteMany({ where });
    console.log(`${project.name} agency data has been reset.`);
  }

  const existing = await prisma.projectSetupState.findUnique({
    where: { projectId: project.id },
  });
  if (existing?.activatedAt) {
    // Setup is complete: pump the continuous agency loop so the
    // signal/insight/opportunity flow (Intelligence surfaces) also fills up.
    console.log(
      `${project.name} setup is complete — pumping the continuous agency loop...`,
    );
    // Pull the scan schedule forward: otherwise the first scan is scheduled
    // hours later and the signal/finding surfaces stay empty.
    // The task backlog left over from setup fills up the concurrency limit,
    // so scanning never starts; we temporarily raise the limit for the sake
    // of demo data.
    const policyBefore = await prisma.autonomyPolicy.findFirst({
      where: { projectId: project.id },
      select: { id: true, maxConcurrentResearchTasks: true },
    });
    if (policyBefore) {
      await prisma.autonomyPolicy.update({
        where: { id: policyBefore.id },
        data: { maxConcurrentResearchTasks: 200 },
      });
    }

    const rounds = 25;
    for (let i = 0; i < rounds; i += 1) {
      await prisma.projectSignalProfile.updateMany({
        where: { projectId: project.id, intensity: { not: "OFF" } },
        data: { nextScanAt: new Date() },
      });
      await ExecutionWorker.tick();
      process.stdout.write(`\r  round ${i + 1}/${rounds}   `);
    }

    if (policyBefore) {
      await prisma.autonomyPolicy.update({
        where: { id: policyBefore.id },
        data: {
          maxConcurrentResearchTasks: policyBefore.maxConcurrentResearchTasks,
        },
      });
    }
    console.log("");
    await printSummary(prisma, project.id);
    await prisma.$disconnect();
    return;
  }
  if (existing) {
    console.log(
      `${project.name} setup is in progress — resuming from where it left off...`,
    );
  } else {
    console.log(
      `Starting agency setup for ${project.name} (${manual ? "manual approval" : "auto approval"}, mock)...`,
    );
  }

  // In automatic mode the seeded policy's (setupAutoApprove:false)
  // preference shouldn't override this — also fix it when resuming
  // half-finished setups.
  if (!manual) {
    await prisma.autonomyPolicy.updateMany({
      where: { projectId: project.id },
      data: { setupAutoApprove: true },
    });
  }

  if (!existing)
    await ProjectSetupOrchestrator.start(
      {
        workspaceId: project.workspaceId,
        projectId: project.id,
        brandId: brand.id,
      },
      {
        brandName: project.name,
        domain: project.domain ?? `${slug}.com`,
        description:
          "Europe-focused marketplace. We want growth, brand awareness, social media, SEO, and creative operations.",
        autoApprove: !manual,
      },
    );

  const maxTicks = 80;
  for (let i = 0; i < maxTicks; i += 1) {
    await ExecutionWorker.tick();
    const state = await prisma.projectSetupState.findUnique({
      where: { projectId: project.id },
      include: { stageRecords: { select: { stage: true, status: true } } },
    });
    if (!state) break;
    const done = state.stageRecords.filter(
      (r) => r.status === "COMPLETED" || r.status === "SKIPPED",
    ).length;
    process.stdout.write(
      `\r  tick ${i + 1}/${maxTicks} · stage: ${state.currentStage} · ${done}/12 done   `,
    );
    if (state.activatedAt) {
      console.log("\nActivation complete!");
      break;
    }
    const waiting = state.stageRecords.find(
      (r) => r.status === "WAITING_CLIENT",
    );
    if (waiting && manual) {
      console.log(
        "\nReached the WAITING_CLIENT stage — you can test the decision UI.",
      );
      break;
    }
    if (waiting && !manual) {
      // Approve the parked decision stage on behalf of the system
      // (half-finished setups may have landed here before the policy fix).
      await ProjectSetupOrchestrator.submitClientDecision(
        project.id,
        waiting.stage,
        { approve: true },
      );
    }
  }

  await printSummary(prisma, project.id);
  await prisma.$disconnect();
}

type CountingClient = {
  [
    K in
      | "signal"
      | "insight"
      | "opportunity"
      | "idea"
      | "workPlan"
      | "agencyDecision"
      | "projectGoal"
  ]: {
    count(args: { where: { projectId: string } }): Promise<number>;
  };
};

async function printSummary(prisma: CountingClient, projectId: string) {
  const where = { where: { projectId } };
  const [signals, insights, opportunities, ideas, plans, decisions, goals] =
    await Promise.all([
      prisma.signal.count(where),
      prisma.insight.count(where),
      prisma.opportunity.count(where),
      prisma.idea.count(where),
      prisma.workPlan.count(where),
      prisma.agencyDecision.count(where),
      prisma.projectGoal.count(where),
    ]);
  console.log(
    `Summary — signals: ${signals}, insights: ${insights}, opportunities: ${opportunities}, ideas: ${ideas}, plans: ${plans}, decisions: ${decisions}, goals: ${goals}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
