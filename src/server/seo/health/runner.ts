import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { HEALTH_EVERY_MS } from "@/lib/seo/audit-constants";
import {
  SeoFlags,
  seoGlobalWorkAllowedHere,
  seoMockMode,
  seoRestrictedProjects,
  seoWorkAllowedFor,
} from "@/lib/seo/health-flags";
import {
  kindsForSource,
  type SeoAlertDraft,
} from "@/lib/seo/health/alert-kinds";
import { evaluateSearchHealth } from "@/lib/seo/health/checks";
import {
  computeSearchHealthScore,
  parseStoredScore,
  type SearchHealthScore,
} from "@/lib/seo/health/score";
import { Heartbeat } from "@/server/observability/heartbeat";
import { SeoSites } from "@/server/seo/site/sites";

import { raiseSeoAlerts } from "./alerts";
import { loadHealthSnapshot } from "./snapshot";

// Arama sağlığı koşucusu (docs/search-health.md "Kontroller"): `seo-health`
// tick adımı, `seo-crawl`'dan sonra (bekçinin bulduğu noindex aynı tick'te
// uyarıya döner). Aday siteler SeoSite.healthDueAt'e göre (geçerli kip,
// izin listesi WHERE'de); CAS ile healthDueAt 6 saat ileri alınarak
// sahiplenilir. Değerlendirme: snapshot → SH1–SH27 → puan → SiteAlerts
// (taslaklar raise, kaynak başına resolveMissing) → healthScore/healthParts.
// PAUSED/CLOSED ya da kapsamı ve GSC bağı olmayan projede her şey çözülür ve
// site boşa alınır (healthDueAt = null). SEO_HEALTH kapalıyken hiçbir sorgu
// yok.

const HEARTBEAT_KEY = "seo.health";
const CANDIDATES = 25;

type Evaluation = {
  score: SearchHealthScore;
  drafts: SeoAlertDraft[];
  raised: number;
  resolved: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NOTHING_AVAILABLE = {
  indexing: false,
  technical: false,
  sitemap_robots: false,
  cwv: false,
  data: false,
} as const;

async function evaluateProject(
  projectId: string,
  now: Date = new Date(),
): Promise<Evaluation | null> {
  const snapshot = await loadHealthSnapshot(projectId, now);
  if (!snapshot) return null;

  const inactive =
    snapshot.projectStatus === "PAUSED" ||
    snapshot.projectStatus === "CLOSED" ||
    (!snapshot.hasScope && !snapshot.hasGscLink);
  if (inactive) {
    // Kaynak kapandı: bütün türler taslaksız değerlendirilir (hepsi kapanır).
    const { resolved } = await raiseSeoAlerts({
      workspaceId: snapshot.workspaceId,
      projectId,
      drafts: [],
      evaluated: { GSC: kindsForSource("GSC"), SEO: kindsForSource("SEO") },
      now,
    });
    const score = computeSearchHealthScore({
      drafts: [],
      available: NOTHING_AVAILABLE,
      coveragePoint: null,
      technicalCleanShare: null,
    });
    if (snapshot.siteId) {
      await prisma.seoSite.updateMany({
        where: { id: snapshot.siteId },
        data: {
          healthDueAt: null,
          healthScore: null,
          healthParts: Prisma.DbNull,
          healthComputedAt: now,
        },
      });
    }
    return { score, drafts: [], raised: 0, resolved };
  }

  const evaluation = evaluateSearchHealth(snapshot.input);
  const score = computeSearchHealthScore({
    drafts: evaluation.drafts,
    available: evaluation.available,
    coveragePoint: evaluation.coveragePoint,
    technicalCleanShare: evaluation.technicalCleanShare,
  });
  const { raised, resolved } = await raiseSeoAlerts({
    workspaceId: snapshot.workspaceId,
    projectId,
    drafts: evaluation.drafts,
    evaluated: evaluation.evaluated,
    now,
  });
  if (snapshot.siteId) {
    await prisma.seoSite.updateMany({
      where: { id: snapshot.siteId },
      data: {
        healthScore: score.value,
        healthParts: score as unknown as Prisma.InputJsonValue,
        healthComputedAt: now,
      },
    });
  }
  return { score, drafts: evaluation.drafts, raised, resolved };
}

export const SeoHealth = {
  // Tick adımı.
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (!SeoFlags.health()) return 0;
    const global = seoGlobalWorkAllowedHere();
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
    try {
      await SeoSites.reconcileDue(now);
    } catch (error) {
      console.error(
        "[seo-health] sites could not be reconciled:",
        messageOf(error),
      );
    }

    const restricted = seoRestrictedProjects();
    const candidates = await prisma.seoSite.findMany({
      where: {
        isMock: seoMockMode(),
        healthDueAt: { not: null, lte: now },
        ...(restricted ? { projectId: { in: restricted } } : {}),
      },
      orderBy: { healthDueAt: "asc" },
      take: CANDIDATES,
      select: { id: true, projectId: true, healthDueAt: true },
    });

    let processed = 0;
    for (const site of candidates) {
      if (processed >= limit) break;
      if (!seoWorkAllowedFor(site.projectId)) continue;
      // CAS: healthDueAt değişmediyse bu süreç alır; deploy örtüşmesinde
      // ikinci kopya aynı siteyi değerlendirmez.
      const claimed = await prisma.seoSite.updateMany({
        where: { id: site.id, healthDueAt: site.healthDueAt },
        data: { healthDueAt: new Date(now.getTime() + HEALTH_EVERY_MS) },
      });
      if (claimed.count === 0) continue;
      processed += 1;
      try {
        await evaluateProject(site.projectId, now);
      } catch (error) {
        console.error(
          `[seo-health] project ${site.projectId} could not be evaluated:`,
          messageOf(error),
        );
      }
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  evaluateProject,
};

export async function readSearchHealthScore(
  projectId: string,
): Promise<{ score: SearchHealthScore; computedAt: Date } | null> {
  const site = await prisma.seoSite.findUnique({
    where: { projectId_isMock: { projectId, isMock: seoMockMode() } },
    select: { healthParts: true, healthComputedAt: true },
  });
  if (!site?.healthComputedAt) return null;
  const score = parseStoredScore(site.healthParts);
  return score ? { score, computedAt: site.healthComputedAt } : null;
}
