import "server-only";

import { prisma } from "@/lib/prisma";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { claimPeriodic } from "@/server/observability/periodic";

import { getBillingConfig } from "./config";
import { ensurePeriod, reapExpiredReservations } from "./ledger";
import { drainParkedWork, resumeParkedWork } from "./park";
import { settleDeliveredOrphans } from "./reconcile";

// Bakım adımı (agency tick'ine bağlı): (1) vadesi gelen pencereleri yeniler,
// (2) teslim edilmiş ama mahsup edilmemiş işleri (süreç çökmesi) mahsup eder,
// (3) çökmüş işlerin tuttuğu rezervasyonları iade eder, (4) hakkı yenilenen/yatan
// workspace'lerin park edilmiş işlerini kuyruğa döndürür. Reserve öncesi tembel
// ensurePeriod zaten vardır; bu adım yalnız boşta kalan workspace'lerin sayılarını
// güncel tutar ve sızıntıyı kapatır.
//
// Canlı veritabanını paylaşan geliştirme sürecinde (metaWorkExcludedHere ile aynı
// yüklem) SORGUSUZ 0 döner: yerel bir makine canlı bakiyeleri taslak plan
// sabitleriyle yeniden yazmasın.
//
// BILLING_MODE=off iken defter işlerine dokunulmaz; yalnız SAATTE BİR parklı iş var
// mı diye bakılır (tek ucuz sorgu): operatör enforce'u kapatınca park edilmiş işler
// sonsuza dek asılı kalmamalı (kill-switch). shadow'da hiçbir şey park olmaz,
// kalanlar her tick boşaltılır.

const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DRAIN_INTERVAL_MS = 60 * 60 * 1000;
let lastRunMs = 0;
let lastDrainMs = 0;

const DUE_BALANCES_SQL = `
SELECT DISTINCT b."workspaceId"
  FROM "UsageBalance" b
  JOIN "Subscription" s ON s."workspaceId" = b."workspaceId"
 WHERE b."periodEnd" <= ($1::timestamptz AT TIME ZONE 'UTC')
   AND s."status" IN ('ACTIVE', 'CANCELED')
   AND s."paidThrough" > b."periodEnd"
 LIMIT $2::int
`;

// Ücretli ama hiç bakiye satırı olmayan (ödeme geldi, ilk pencere açılmadı) abonelikler.
const MISSING_BALANCE_SQL = `
SELECT s."workspaceId"
  FROM "Subscription" s
 WHERE s."status" IN ('ACTIVE', 'TRIALING')
   AND NOT EXISTS (SELECT 1 FROM "UsageBalance" b WHERE b."workspaceId" = s."workspaceId")
 LIMIT $1::int
`;

// Faturalama kapalıyken: yalnız saatte bir, park edilmiş iş kaldıysa onları bırak.
async function drainWhenOff(now: Date): Promise<number> {
  if (now.getTime() - lastDrainMs < DRAIN_INTERVAL_MS) return 0;
  lastDrainMs = now.getTime();
  if (!(await claimPeriodic("billing.drain", DRAIN_INTERVAL_MS, now))) return 0;
  try {
    const drained = await drainParkedWork({ now });
    return drained.resumed + drained.cancelled;
  } catch (error) {
    console.error(
      "[billing] could not drain parked work:",
      error instanceof Error ? error.name : error,
    );
    return 0;
  }
}

export async function runBillingTick(now: Date = new Date()): Promise<number> {
  if (metaWorkExcludedHere(process.env)) return 0;
  if (getBillingConfig().mode === "off") return drainWhenOff(now);
  if (now.getTime() - lastRunMs < MIN_INTERVAL_MS) return 0;
  lastRunMs = now.getTime();
  if (!(await claimPeriodic("billing.tick", MIN_INTERVAL_MS, now))) return 0;

  let work = 0;

  try {
    const due = await prisma.$queryRawUnsafe<Array<{ workspaceId: string }>>(
      DUE_BALANCES_SQL,
      now,
      50,
    );
    const missing = await prisma.$queryRawUnsafe<
      Array<{ workspaceId: string }>
    >(MISSING_BALANCE_SQL, 50);
    const ids = new Set([...due, ...missing].map((row) => row.workspaceId));
    for (const workspaceId of ids) {
      try {
        const { changed } = await ensurePeriod(workspaceId, { now });
        if (changed) work += 1;
      } catch (error) {
        console.error(
          "[billing] ensurePeriod failed:",
          error instanceof Error ? error.name : error,
        );
      }
    }
  } catch (error) {
    console.error(
      "[billing] could not select due windows:",
      error instanceof Error ? error.name : error,
    );
  }

  // Teslim edilmiş işin süresi dolan rezervasyonu iade DEĞİL mahsup edilir:
  // süpürücüden ÖNCE.
  try {
    work += await settleDeliveredOrphans({ now, limit: 100 });
  } catch (error) {
    console.error(
      "[billing] reconcile failed:",
      error instanceof Error ? error.name : error,
    );
  }

  try {
    const { released } = await reapExpiredReservations({ now, limit: 100 });
    work += released;
  } catch (error) {
    console.error(
      "[billing] reaper failed:",
      error instanceof Error ? error.name : error,
    );
  }

  try {
    const resumed = await resumeParkedWork({ now, limit: 100 });
    work += resumed.resumed + resumed.cancelled;
  } catch (error) {
    console.error(
      "[billing] resume failed:",
      error instanceof Error ? error.name : error,
    );
  }

  return work;
}

// Testler için: bellek içi kısmayı sıfırla.
export function resetBillingTickThrottle(): void {
  lastRunMs = 0;
  lastDrainMs = 0;
}
