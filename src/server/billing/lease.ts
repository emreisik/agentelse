import "server-only";

import { prisma } from "@/lib/prisma";
import { claimPeriodic } from "@/server/observability/periodic";

// Kısa ömürlü, süreçler arası kilit: aynı işin (ör. bir gönderinin görsel
// revizyonunun) aynı anda iki kez koşmasını önler. SystemHeartbeat satırı üzerinde
// çalışır (yeni tablo yok): alma `claimPeriodic` ile CAS'tir, bırakma yalnız
// KENDİ aldığı satırı siler. Süre dolarsa kilit kendiliğinden düşer (çöken bir
// süreç işi sonsuza dek kilitlemez).
//
// Neden gerekli: "ücretsiz revizyon mu?" kararı okunup sonra çizim yapıldığı için
// (30-120 sn) eşzamanlı N istek hepsi "ücretsiz" görür. Kilit karar+çizimi
// gönderi başına sıraya dizer.

export type Lease = { release(): Promise<void> };

export async function acquireLease(
  key: string,
  ttlMs: number,
  now: Date = new Date(),
): Promise<Lease | null> {
  if (!(await claimPeriodic(key, ttlMs, now))) return null;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      try {
        await prisma.$executeRaw`DELETE FROM "SystemHeartbeat" WHERE "key" = ${key} AND "lastBeatAt" = ${now}`;
      } catch (error) {
        // Bırakılamayan kilit süresi dolunca düşer; iş sonucunu bozmaz.
        console.error(
          `[lease] ${key} could not be released:`,
          error instanceof Error ? error.message : error,
        );
      }
    },
  };
}
