import "server-only";

import { prisma } from "@/lib/prisma";
import { FINDING_RETENTION_DAYS } from "@/lib/seo/finding-lifecycle";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { SeoInsightFlags } from "@/lib/seo/insight-flags";
import { claimPeriodic } from "@/server/observability/periodic";

// SEO fırsat motorunun saklaması (docs/search-opportunities.md "Bulgu yaşam
// döngüsü"): bulgular 24 ay, STALE kümeler 56 gün; sözlükten silinmiş
// sorguların embedding'leri hemen. Günde bir, yalnız canlıda (paylaşılan
// kilit; geliştirme süreci hiç çalıştırmaz). W1 GscRetention gibi bayrağa
// bağlı değildir: SEO_INSIGHTS sonradan kapatılsa da motor verisi kaldığı
// sürece çalışır (24 ay sözü tutulur). Bayrak kapalıyken motor verisi yoksa
// bu süreç 24 saat boyunca yeniden bakmaz (her tick'te sorgu yok; bayrak
// kapalıyken yeni motor verisi oluşmaz).

const RETENTION_KEY = "seo.opportunities-retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
const STALE_CLUSTER_DAYS = 56;
const BATCH = 1_000;
const MAX_BATCHES = 50;

async function deleteOldFindings(cutoff: Date): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const ids = (
      await prisma.seoFinding.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      })
    ).map((row) => row.id);
    if (ids.length === 0) break;
    const result = await prisma.seoFinding.deleteMany({
      where: { id: { in: ids } },
    });
    deleted += result.count;
    if (ids.length < BATCH) break;
  }
  return deleted;
}

async function deleteOrphanEmbeddings(): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const count = await prisma.$executeRaw`
      DELETE FROM "SeoQueryEmbedding"
       WHERE "id" IN (
         SELECT e."id"
           FROM "SeoQueryEmbedding" e
          WHERE NOT EXISTS (
            SELECT 1 FROM "GscQuery" q WHERE q."id" = e."queryId"
          )
          LIMIT ${BATCH}
       )
    `;
    deleted += count;
    if (count < BATCH) break;
  }
  return deleted;
}

let idleCheckedAt: number | null = null;

async function engaged(now: Date): Promise<boolean> {
  if (SeoInsightFlags.active()) return true;
  if (idleCheckedAt !== null && now.getTime() - idleCheckedAt < EVERY_MS) {
    return false;
  }
  const state = await prisma.seoEngineState.findFirst({
    select: { id: true },
  });
  idleCheckedAt = state ? null : now.getTime();
  return state !== null;
}

export const SeoOpportunityRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gscGlobalWorkAllowedHere()) return 0;
    if (!(await engaged(now))) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;

    const findings = await deleteOldFindings(
      new Date(now.getTime() - FINDING_RETENTION_DAYS * DAY_MS),
    );
    const clusters = await prisma.seoCluster.deleteMany({
      where: {
        status: "STALE",
        updatedAt: {
          lt: new Date(now.getTime() - STALE_CLUSTER_DAYS * DAY_MS),
        },
      },
    });
    const embeddings = await deleteOrphanEmbeddings();
    return findings + clusters.count + embeddings;
  },

  // Testler için: süreç içi "veri yok" önbelleğini sıfırlar.
  resetIdleCheck(): void {
    idleCheckedAt = null;
  },
};
