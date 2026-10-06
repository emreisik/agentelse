import "server-only";

import type { IdeaStatus, Prisma } from "@prisma/client";

import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { prisma } from "@/lib/prisma";
import { GOOGLE_PROVIDER } from "@/server/integrations/google/services";

import { GA_LEARNING_SOURCE_TYPE } from "./learnings";
import { GA_INSIGHT_SIGNAL_SOURCE } from "./signals";

// Disconnect (google-disconnect.ts): GA-F4 bulgularından türeyen her şey
// hemen silinir: ga-insights sinyalleri, onlardan doğan ajans bulguları ve
// içgörüler, kullanıcının dokunmadığı fırsatlar, GA4 öğrenmeleri ve havuzda
// bekleyen (APPROVED olmayan) "website" fikirleri. Kabul edilmiş/dönüştürülmüş
// fırsatlar ve kullanılmış fikirler kalır (metinleri yol ve sayı taşımaz);
// SC-F4 forget kuralıyla aynı biçimde onaylanmış (APPROVED) fikirler de
// kullanılmış sayılır, yalnız kanıt bağlantıları (concept.evidence) çıkarılır.
// GaFinding ve GaAnalysisRun bağla birlikte cascade ile gider. Search Console
// kimliği no-op.

export type GaInsightCleanupResult = {
  signals: number;
  findings: number;
  insights: number;
  opportunities: number;
  learnings: number;
  ideas: number;
};

const UNTOUCHED_OPPORTUNITY_STATUSES = [
  "NEW",
  "REVIEWING",
  "EVALUATED",
  "DUPLICATE",
  "EXPIRED",
  "DISMISSED",
] as const;

const DELETABLE_IDEA_STATUSES: readonly IdeaStatus[] =
  IDEA_POOL_STATUSES.filter((status) => status !== "APPROVED");

function conceptRecord(
  value: Prisma.JsonValue | null,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ZERO: GaInsightCleanupResult = {
  signals: 0,
  findings: 0,
  insights: 0,
  opportunities: 0,
  learnings: 0,
  ideas: 0,
};

export async function deleteGaInsightDerivedData(
  projectId: string,
): Promise<GaInsightCleanupResult> {
  return prisma.$transaction(async (tx) => {
    const signalIds = (
      await tx.signal.findMany({
        where: { projectId, source: GA_INSIGHT_SIGNAL_SOURCE },
        select: { id: true },
      })
    ).map((row) => row.id);
    const findingIds =
      signalIds.length > 0
        ? (
            await tx.finding.findMany({
              where: { projectId, signalId: { in: signalIds } },
              select: { id: true },
            })
          ).map((row) => row.id)
        : [];
    const overlap: Prisma.InsightWhereInput[] = [];
    if (signalIds.length > 0)
      overlap.push({ signalIds: { hasSome: signalIds } });
    if (findingIds.length > 0) {
      overlap.push({ findingIds: { hasSome: findingIds } });
    }
    const insightIds =
      overlap.length > 0
        ? (
            await tx.insight.findMany({
              where: { projectId, OR: overlap },
              select: { id: true },
            })
          ).map((row) => row.id)
        : [];

    const opportunities =
      insightIds.length > 0
        ? await tx.opportunity.deleteMany({
            where: {
              projectId,
              insightId: { in: insightIds },
              status: { in: [...UNTOUCHED_OPPORTUNITY_STATUSES] },
            },
          })
        : { count: 0 };
    const insights =
      insightIds.length > 0
        ? await tx.insight.deleteMany({ where: { id: { in: insightIds } } })
        : { count: 0 };
    const findings =
      findingIds.length > 0
        ? await tx.finding.deleteMany({ where: { id: { in: findingIds } } })
        : { count: 0 };
    const signals =
      signalIds.length > 0
        ? await tx.signal.deleteMany({ where: { id: { in: signalIds } } })
        : { count: 0 };
    const learnings = await tx.brandLearning.deleteMany({
      where: { projectId, sourceType: GA_LEARNING_SOURCE_TYPE },
    });
    const websiteIdeas: Prisma.IdeaWhereInput = {
      projectId,
      concept: { path: ["source"], equals: "website" },
    };
    const ideas = await tx.idea.deleteMany({
      where: { ...websiteIdeas, status: { in: [...DELETABLE_IDEA_STATUSES] } },
    });
    let stripped = 0;
    const approved = await tx.idea.findMany({
      where: { ...websiteIdeas, status: "APPROVED" },
      select: { id: true, concept: true },
    });
    for (const row of approved) {
      const concept = conceptRecord(row.concept);
      if (!concept || !("evidence" in concept)) continue;
      const rest: Record<string, unknown> = { ...concept };
      delete rest.evidence;
      await tx.idea.update({
        where: { id: row.id },
        data: { concept: rest as Prisma.InputJsonValue },
      });
      stripped += 1;
    }
    return {
      signals: signals.count,
      findings: findings.count,
      insights: insights.count,
      opportunities: opportunities.count,
      learnings: learnings.count,
      ideas: ideas.count + stripped,
    };
  });
}

export async function deleteGaInsightDerivedDataForCredential(
  credentialId: string,
): Promise<GaInsightCleanupResult> {
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: credentialId },
    select: { projectId: true, provider: true },
  });
  if (!credential || credential.provider !== GOOGLE_PROVIDER.analytics) {
    return { ...ZERO };
  }
  return deleteGaInsightDerivedData(credential.projectId);
}

// Disconnect'te temizlik başarısız olduysa (zaman aşımı, kilitlenme) kalan
// türevler: canlı (ACTIVE/EXPIRED) GA bağlantısı olmayan projelerin
// ga-insights sinyalleri ve GA4 öğrenmeleri günlük GaRetention'da silinir.
export async function sweepOrphanGaInsightData(): Promise<number> {
  const [signalProjects, learningProjects] = await Promise.all([
    prisma.signal.groupBy({
      by: ["projectId"],
      where: { source: GA_INSIGHT_SIGNAL_SOURCE },
    }),
    prisma.brandLearning.groupBy({
      by: ["projectId"],
      where: { sourceType: GA_LEARNING_SOURCE_TYPE },
    }),
  ]);
  const projectIds = [
    ...new Set(
      [...signalProjects, ...learningProjects].map((row) => row.projectId),
    ),
  ];
  if (projectIds.length === 0) return 0;
  const live = new Set(
    (
      await prisma.integrationCredential.findMany({
        where: {
          projectId: { in: projectIds },
          provider: GOOGLE_PROVIDER.analytics,
          status: { in: ["ACTIVE", "EXPIRED"] },
        },
        select: { projectId: true },
      })
    ).map((row) => row.projectId),
  );
  let deleted = 0;
  for (const projectId of projectIds) {
    if (live.has(projectId)) continue;
    const result = await deleteGaInsightDerivedData(projectId);
    deleted +=
      result.signals +
      result.findings +
      result.insights +
      result.opportunities +
      result.learnings +
      result.ideas;
  }
  return deleted;
}
