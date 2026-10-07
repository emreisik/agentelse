import "server-only";

import { prisma } from "@/lib/prisma";
import { SeoContentPlanFlags } from "@/lib/seo/content-plan/flags";
import { gscGlobalWorkAllowedHere } from "@/lib/seo/flags";
import { claimPeriodic } from "@/server/observability/periodic";

import { forgetSeoContentPlanRows } from "./forget";

// Aylık SEO planının saklaması (docs/search-content-plan.md "Gizlilik"): plan
// satırları 14 ay. Silmeden ÖNCE forget çalışır (dokunulmamış slot parçaları ve
// plana ait fikirler gider), böylece Google türevi başlıklar yazılmış
// makaleler dışında geride kalmaz. Günde bir, yalnız canlıda (paylaşılan kilit;
// geliştirme süreci canlı DB'yi paylaşırken hiç çalıştırmaz). Bayrağa bağlı
// değildir: SEO_CONTENT_PLAN sonradan kapatılsa da satır kaldığı sürece söz
// tutulur. Bayrak kapalıyken satır yoksa varlık sorgusu 24 saatte bir yapılır.

const RETENTION_KEY = "seo.content-plan-retention";
const EVERY_MS = 24 * 3_600_000;
export const PLAN_RETENTION_MONTHS = 14;
const BATCH = 200;
const MAX_BATCHES = 50;

// 14 ay öncesinin ayı: bu ayın (UTC) 14 ay gerisi; daha eski aylar silinir.
export function retentionCutoffMonth(now: Date): string {
  const total =
    now.getUTCFullYear() * 12 + now.getUTCMonth() - PLAN_RETENTION_MONTHS;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Bayrak kapalıyken (satır var ya da yok) süreç 24 saatte en çok bir kez
// yoklar: yoklama anından sonra o pencerede ne probe ne kilit sorgusu çalışır.
// Satır varsa yoklamanın kendisi temizliğe devam eder.
let lastProbeAt: number | null = null;

async function engaged(now: Date): Promise<boolean> {
  if (SeoContentPlanFlags.on()) return true;
  if (lastProbeAt !== null && now.getTime() - lastProbeAt < EVERY_MS) {
    return false;
  }
  lastProbeAt = now.getTime();
  const row = await prisma.seoContentPlan.findFirst({ select: { id: true } });
  return row !== null;
}

export const SeoContentPlanRetention = {
  // Silinen plan satırı sayısı.
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gscGlobalWorkAllowedHere()) return 0;
    if (!(await engaged(now))) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;

    const cutoff = retentionCutoffMonth(now);
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await prisma.seoContentPlan.findMany({
        where: { month: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      });
      if (rows.length === 0) break;
      const result = await forgetSeoContentPlanRows(rows.map((row) => row.id));
      deleted += result.plans;
      // Hiçbiri silinemediyse aynı satırlar üzerinde dönme.
      if (result.plans === 0 || rows.length < BATCH) break;
    }
    return deleted;
  },

  // Testler için: süreç içi yoklama önbelleğini sıfırlar.
  resetIdleCheck(): void {
    lastProbeAt = null;
  },
};
