// Production migration helper: deletes ALL Agency OS data left over from
// the seed/demo period (setup state, constitution, signals, insights,
// opportunities, ideas, councils, decisions, goals, audits, work plans,
// and agency tasks) on a per-project basis. Projects, brands, users, the
// board, and browser profiles REMAIN — setup can be restarted with real
// providers from the `/kurulum` page.
//
//   npm run db:reset:agency            -> all projects with setup state
//   npm run db:reset:agency -- biduniq -> only the given slugs
//
// Also prepares for production: browser profiles' externalProfileId is
// bound to the "hubconnect" OpenClaw agent and setupAutoApprove is turned
// off (in a real setup, the client makes the decisions).

process.loadEnvFile(".env");

import { createRequire } from "node:module";
const nodeRequire = createRequire(import.meta.url);
const serverOnlyPath = nodeRequire.resolve("server-only");
nodeRequire.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
} as never;

const OPENCLAW_AGENT_ID = "hubconnect";

async function main() {
  const { prisma } = await import("../src/lib/prisma");

  const slugArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const setupProjectIds = (
    await prisma.projectSetupState.findMany({ select: { projectId: true } })
  ).map((s) => s.projectId);
  const projects = await prisma.project.findMany({
    where: slugArgs.length
      ? { slug: { in: slugArgs } }
      : { id: { in: setupProjectIds } },
    select: { id: true, slug: true, name: true, workspaceId: true },
  });

  if (projects.length === 0) {
    console.log("No projects found to reset.");
    await prisma.$disconnect();
    return;
  }

  for (const project of projects) {
    const where = { projectId: project.id };
    console.log(`\n${project.name} (${project.slug}) is being reset...`);

    // Agency tasks: those tied to a work plan/department + the discovery
    // tasks setup opened via SYSTEM.
    const agencyTasks = await prisma.task.findMany({
      where: {
        projectId: project.id,
        OR: [
          { workPlanId: { not: null } },
          { departmentKey: { not: null } },
          { createdByType: "SYSTEM" },
        ],
      },
      select: { id: true },
    });
    const taskIds = agencyTasks.map((t) => t.id);

    if (taskIds.length > 0) {
      const jobWhere = { taskId: { in: taskIds } };
      await prisma.outboxEvent.deleteMany({
        where: { executionJob: jobWhere },
      });
      await prisma.deadLetterJob.deleteMany({
        where: { executionJob: jobWhere },
      });
      await prisma.executionVerification.deleteMany({
        where: { executionJob: jobWhere },
      });
      await prisma.executionJob.deleteMany({ where: jobWhere });
      await prisma.approval.deleteMany({ where: jobWhere });
      await prisma.humanInterventionRequest.deleteMany({ where: jobWhere });
      await prisma.taskDependency.deleteMany({
        where: {
          OR: [
            { taskId: { in: taskIds } },
            { dependsOnTaskId: { in: taskIds } },
          ],
        },
      });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }

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

    // Production: the client makes the setup decisions.
    await prisma.autonomyPolicy.updateMany({
      where,
      data: { setupAutoApprove: false },
    });

    // Bind browser profiles to the isolated "hubconnect" OpenClaw agent.
    const boundProfiles = await prisma.browserProfile.updateMany({
      where,
      data: { externalProfileId: OPENCLAW_AGENT_ID },
    });

    console.log(
      `  ${taskIds.length} agency tasks deleted · ${boundProfiles.count} profiles bound to the "${OPENCLAW_AGENT_ID}" agent`,
    );
  }

  console.log(
    `\n${projects.length} projects reset. For a real setup: project > Setup page.`,
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
