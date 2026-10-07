import "server-only";

import { prisma } from "@/lib/prisma";
import { WEBSITE_GOAL_KEYS } from "@/lib/website-analytics/analysis/types";
import {
  WEBSITE_REPORT_COMMAND_PREFIX,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";
import { forgetWebsiteSharesForProject } from "@/server/website-analytics/agency/share-forget";

// Disconnect (google-disconnect.ts): GA-F5 rapor kartları hemen silinir; boş
// kalan "Website analytics" sohbeti (kullanıcının mesajı ya da gönderisi yoksa)
// Recents'te kalmasın diye o da gider. web.* hedeflerinin currentValue'su
// boşaltılır (hedefin kendisi ve targetValue kalır), GaGoalProgress silinir.
// GaReportRun ve GaGoalProgress bağla birlikte cascade ile de gider. Bayraktan
// bağımsızdır: kart bayrak açıkken yazılmış olabilir.

export type GaReportCleanupResult = {
  commands: number;
  goals: number;
  progress: number;
  works: number;
};

export async function deleteGaReportData(
  projectId: string,
): Promise<GaReportCleanupResult> {
  const workId = websiteWorkId(projectId);
  const result = await prisma.$transaction(async (tx) => {
    const commands = await tx.command.deleteMany({
      where: {
        projectId,
        workId,
        source: "SYSTEM",
        id: { startsWith: WEBSITE_REPORT_COMMAND_PREFIX },
      },
    });
    const works = await tx.work.deleteMany({
      where: {
        id: workId,
        projectId,
        commands: { none: {} },
        posts: { none: {} },
      },
    });
    const goals = await tx.projectGoal.updateMany({
      where: { projectId, metricKey: { in: [...WEBSITE_GOAL_KEYS] } },
      data: { currentValue: null },
    });
    const progress = await tx.gaGoalProgress.deleteMany({
      where: { projectId },
    });
    return {
      commands: commands.count,
      goals: goals.count,
      progress: progress.count,
      works: works.count,
    };
  });
  // GA-F8: müşteri rapor bağlantıları (ReportShare kind WEBSITE) kartlarla
  // birlikte hemen silinir; hem Disconnect (deleteGaReportDataForCredential)
  // hem yetim süpürmesi (sweepOrphanGaReportData) bu yoldan geçer. Asla
  // fırlatmaz, bayrağa bağlı değildir.
  await forgetWebsiteSharesForProject(projectId);
  return result;
}

export async function deleteGaReportDataForCredential(
  credentialId: string,
): Promise<GaReportCleanupResult> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: credentialId },
    select: { projectId: true, provider: true },
  });
  if (
    !credential ||
    !credential.projectId ||
    credential.provider !== GOOGLE_PROVIDER.analytics
  ) {
    return { commands: 0, goals: 0, progress: 0, works: 0 };
  }
  return deleteGaReportData(credential.projectId);
}

// Disconnect'te rapor temizliği başarısız olduysa ya da bağ silindikten sonra
// bir yazar (haftalık/aylık rapor, hedef yenileme) kart ya da hedef değeri
// yazdıysa kalanlar: GA bağı da, canlı (ACTIVE/EXPIRED) GA kimliği de olmayan
// projelerin rapor kartları ve web.* hedef değerleri günlük GaRetention'da
// silinir. Bayraktan bağımsızdır.
export async function sweepOrphanGaReportData(): Promise<number> {
  const [cardProjects, goalProjects] = await Promise.all([
    prisma.command.groupBy({
      by: ["projectId"],
      where: {
        source: "SYSTEM",
        id: { startsWith: WEBSITE_REPORT_COMMAND_PREFIX },
      },
    }),
    prisma.projectGoal.groupBy({
      by: ["projectId"],
      where: {
        metricKey: { in: [...WEBSITE_GOAL_KEYS] },
        currentValue: { not: null },
      },
    }),
  ]);
  const projectIds = [
    ...new Set(
      [...cardProjects, ...goalProjects]
        .map((row) => row.projectId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (projectIds.length === 0) return 0;
  const [links, credentials] = await Promise.all([
    prisma.gaPropertyLink.findMany({
      where: { projectId: { in: projectIds } },
      select: { projectId: true },
    }),
    prisma.integrationCredential.findMany({
      where: {
        projectId: { in: projectIds },
        provider: GOOGLE_PROVIDER.analytics,
        status: { in: ["ACTIVE", "EXPIRED"] },
      },
      select: { projectId: true },
    }),
  ]);
  const live = new Set([
    ...links.map((row) => row.projectId),
    ...credentials.map((row) => row.projectId),
  ]);
  let deleted = 0;
  for (const projectId of projectIds) {
    if (live.has(projectId)) continue;
    const result = await deleteGaReportData(projectId);
    deleted += result.commands + result.goals + result.progress + result.works;
  }
  return deleted;
}
