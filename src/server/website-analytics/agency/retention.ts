import "server-only";

import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { claimPeriodic } from "@/server/observability/periodic";
import { GoogleRisc } from "@/server/integrations/google/risc/retention";
import { sweepOrphanWebsiteShares } from "@/server/website-analytics/agency/share-forget";
import { GaBigQuery } from "@/server/website-analytics/bigquery/reader";

// GA-F8 günlük saklama toplayıcısı (tick adımı "ga-agency-retention"): RISC
// olayları (30 gün), BigQuery günlük toplamları (400 gün) ve başıboş WEBSITE
// paylaşım bağlantıları. BİLİNÇLİ İSTİSNA: GA_AGENCY / GOOGLE_RISC bayraklarına
// BAĞLI DEĞİL; yalnız küresel iş korumasına (canlı veritabanını paylaşan yerel
// süreç koşmaz) ve günde bir kilide bağlı. Gizlilik saklaması, bayrak
// kapatıldıktan sonra da işlemeye devam etmelidir. Paylaşım bağlantılarının
// süre dolumu SC-F9'un kendi tick adımıdır ("report-share-retention"), burada
// tekrarlanmaz.

const DAY_MS = 24 * 60 * 60 * 1000;

export const GaAgencyRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic("ga.agency.retention", DAY_MS, now))) return 0;

    // Bir parçanın hatası diğerlerini engellemez; yalnız hata adı loglanır.
    const parts: { name: string; run: () => Promise<number> }[] = [
      { name: "risc-events", run: () => GoogleRisc.retention(now) },
      { name: "bigquery-days", run: () => GaBigQuery.retention(now) },
      { name: "orphan-shares", run: () => sweepOrphanWebsiteShares() },
    ];
    let removed = 0;
    for (const part of parts) {
      try {
        removed += await part.run();
      } catch (error) {
        console.error(
          `[ga-agency-retention] ${part.name} failed:`,
          error instanceof Error ? error.name : "error",
        );
      }
    }
    return removed;
  },
};
