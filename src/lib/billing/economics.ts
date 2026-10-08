// Kârlılık varsayımları ve marj hesabı: saf. Rakamlar VARSAYIMDIR (spec'in başlangıç
// maliyetleri); gerçek birim maliyet `npm run db:report:cost` ile ölçüldükçe burada
// güncellenir ve plans.test.ts'teki "pazarlık koruması" testi yeni değerlerle yeniden
// koşar. Brüt marjdır: ödeme komisyonu, müşteri edinme, personel, vergi YOK.

import {
  PLANS,
  VIDEO_SELLABLE,
  quotaFor,
  yearlyPerMonthCents,
  type PlanKey,
} from "./plans";

export const ASSUMED_COST = {
  // Görselli içerik başına (ana görsel + uyarlamalar + yazı adımları ortalaması).
  imageUsd: 0.15,
  // 10 sn'lik video başına.
  videoUsd: 1.5,
  // Marka başına aylık altyapı (depolama, DB, tarama).
  infraPerBrandUsd: 1,
} as const;

export const TARGET_GROSS_MARGIN = 0.7;

export type MarginScenario = "normal" | "firstMonth" | "yearly";

// Kotanın tamamı kullanılırsa bir müşterinin aylık brüt marjı [0, 1].
// usage: kullanım oranı (1 = %100). Satılmayan birimler maliyete girmez.
export function grossMargin(
  planKey: PlanKey,
  scenario: MarginScenario = "normal",
  usage = 1,
): number {
  const plan = PLANS[planKey];
  const quota = quotaFor(planKey, { firstMonth: scenario === "firstMonth" });
  const revenueCents =
    scenario === "firstMonth"
      ? plan.firstMonthCents
      : scenario === "yearly"
        ? yearlyPerMonthCents(planKey)
        : plan.monthlyCents;
  const revenue = revenueCents / 100;
  const variable =
    usage *
    (quota.IMAGE * ASSUMED_COST.imageUsd +
      (VIDEO_SELLABLE ? quota.VIDEO * ASSUMED_COST.videoUsd : 0) +
      quota.AI_MICROS / 1_000_000);
  const cost = variable + plan.brandLimit * ASSUMED_COST.infraPerBrandUsd;
  return (revenue - cost) / revenue;
}
