import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { GA_ATTRIBUTION_LEARNING_PREFIX } from "@/lib/website-analytics/attribution/learning";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";

// GA-F6 Disconnect temizliği (docs/website-attribution.md "Limited Use ve
// Disconnect"): GA'dan türeyen iki şey hemen silinir: "ga-utm:" GA4
// öğrenmeleri ve Meta karar kanıtına eklenen düz ga4_* alanları. TrackedLink
// ve LinkTrackingSetting Google verisi taşımaz, kalır (proje silinince gider).
// GA-F4'ün kendi temizliği bütün GA4 öğrenmelerini zaten silmiş olabilir;
// buradaki silme ondan sonra da zararsızdır. Search Console kimliği no-op.

const GA4_LEARNING_SOURCE_TYPE = "GA4";
const EVIDENCE_PREFIX = "ga4_";
const BATCH_SIZE = 500;
// 100.000 karardan sonrası için emniyet freni; yalnız projectId loglanır.
const MAX_BATCHES = 200;

export type GaAttributionCleanupResult = {
  learnings: number;
  decisions: number;
};

function withoutGaKeys(
  value: Prisma.JsonValue,
): Prisma.InputJsonObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const rest: Record<string, Prisma.InputJsonValue | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith(EVIDENCE_PREFIX)) continue;
    rest[key] = entry as Prisma.InputJsonValue | null;
  }
  return rest;
}

export async function deleteGaAttributionData(
  projectId: string,
): Promise<GaAttributionCleanupResult> {
  const learnings = await prisma.brandLearning.deleteMany({
    where: {
      projectId,
      sourceType: GA4_LEARNING_SOURCE_TYPE,
      sourceRef: { startsWith: GA_ATTRIBUTION_LEARNING_PREFIX },
    },
  });

  // JSON yol süzgeci ga4_source'u olan her kararı bulur (otopilot takip
  // kararları kanıtı kopyalar); anahtarlar çıkınca satır süzgeçten düşer.
  let decisions = 0;
  for (let batch = 0; ; batch += 1) {
    const rows = await prisma.adsDecision.findMany({
      where: {
        projectId,
        evidence: { path: ["ga4_source"], equals: GA4_LEARNING_SOURCE_TYPE },
      },
      select: { id: true, evidence: true },
      take: BATCH_SIZE,
    });
    if (rows.length === 0) break;
    if (batch >= MAX_BATCHES) {
      console.error(
        `[ga-attribution] decision cleanup stopped at the safety limit (project ${projectId})`,
      );
      break;
    }
    const updates = rows.flatMap((row) => {
      const evidence = withoutGaKeys(row.evidence);
      return evidence
        ? [
            prisma.adsDecision.update({
              where: { id: row.id },
              data: { evidence },
            }),
          ]
        : [];
    });
    if (updates.length === 0) break;
    await prisma.$transaction(updates);
    decisions += updates.length;
  }

  return { learnings: learnings.count, decisions };
}

export async function deleteGaAttributionDataForCredential(
  credentialId: string,
): Promise<GaAttributionCleanupResult> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: credentialId },
    select: { projectId: true, provider: true },
  });
  if (!credential || credential.provider !== GOOGLE_PROVIDER.analytics) {
    return { learnings: 0, decisions: 0 };
  }
  return deleteGaAttributionData(credential.projectId);
}

// Disconnect temizliği yarıda kaldıysa ya da bağ silindikten sonra bir yazar
// (günlük öğrenme, optimizer kanıtı) yeniden yazdıysa kalanlar: canlı GA bağı
// da, canlı (ACTIVE/EXPIRED) GA kimliği de olmayan projelerin "ga-utm:"
// öğrenmeleri ve karar kanıtındaki ga4_* alanları günlük GaRetention'da silinir.
// Bayraktan bağımsızdır; "Disconnect'te hemen silinir" sözü hata yolunda da tutar.
export async function sweepOrphanGaAttributionData(): Promise<number> {
  const [learningProjects, decisionProjects] = await Promise.all([
    prisma.brandLearning.groupBy({
      by: ["projectId"],
      where: {
        sourceType: GA4_LEARNING_SOURCE_TYPE,
        sourceRef: { startsWith: GA_ATTRIBUTION_LEARNING_PREFIX },
      },
    }),
    prisma.adsDecision.groupBy({
      by: ["projectId"],
      where: {
        evidence: { path: ["ga4_source"], equals: GA4_LEARNING_SOURCE_TYPE },
      },
    }),
  ]);
  const projectIds = [
    ...new Set(
      [...learningProjects, ...decisionProjects]
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
    const result = await deleteGaAttributionData(projectId);
    deleted += result.learnings + result.decisions;
  }
  return deleted;
}
