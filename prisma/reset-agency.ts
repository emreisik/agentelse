// Üretime geçiş yardımcısı: seed/demo döneminden kalan TÜM Agency OS verisini
// (kurulum durumu, anayasa, sinyaller, içgörüler, fırsatlar, fikirler,
// konseyler, kararlar, hedefler, denetimler, iş planları ve ajans görevleri)
// proje bazında siler. Projeler, markalar, kullanıcılar, board ve tarayıcı
// profilleri KALIR — kurulum `/kurulum` sayfasından gerçek sağlayıcılarla
// yeniden başlatılabilir.
//
//   npm run db:reset:agency            -> setup durumu olan tüm projeler
//   npm run db:reset:agency -- biduniq -> yalnız verilen slug'lar
//
// Ayrıca üretim hazırlığı: tarayıcı profillerinin externalProfileId'si
// "hubconnect" OpenClaw ajanına bağlanır ve setupAutoApprove kapatılır
// (gerçek kurulumda kararları müşteri verir).

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
    console.log("Sıfırlanacak proje bulunamadı.");
    await prisma.$disconnect();
    return;
  }

  for (const project of projects) {
    const where = { projectId: project.id };
    console.log(`\n${project.name} (${project.slug}) sıfırlanıyor...`);

    // Ajans görevleri: iş planına/departmana bağlı olanlar + kurulumun
    // SYSTEM tarafından açtığı keşif görevleri.
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

    // Üretim: kurulum kararlarını müşteri verir.
    await prisma.autonomyPolicy.updateMany({
      where,
      data: { setupAutoApprove: false },
    });

    // Tarayıcı profillerini izole "hubconnect" OpenClaw ajanına bağla.
    const boundProfiles = await prisma.browserProfile.updateMany({
      where,
      data: { externalProfileId: OPENCLAW_AGENT_ID },
    });

    console.log(
      `  ${taskIds.length} ajans görevi silindi · ${boundProfiles.count} profil "${OPENCLAW_AGENT_ID}" ajanına bağlandı`,
    );
  }

  console.log(
    `\n${projects.length} proje sıfırlandı. Gerçek kurulum için: proje > Kurulum sayfası.`,
  );
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
