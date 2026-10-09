import {
  APPROVE_ABOVE_MIN_USD,
  approveAboveRange,
  effectiveApproveAbove,
} from "./approval-threshold";
import { PLANS, type PlanKey } from "./plans";

// Kullanıcının kendi koyduğu sınırların PLANI AŞMAMASI (Faz 3C): saf ve izomorfik.
//  - Günlük bütçe: planın aylık AI bütçesinden büyük olamaz (günlük sınır aylıktan geniş
//    anlamsız ve yanıltıcı olur).
//  - Onay eşiği: paket varsayılanının [0,10 ... 5 katı] aralığında seçilir.
// Plan yoksa (faturalama kapalı/sınırsız) yalnız mutlak sınırlar uygulanır.
// "Sınırsız mod" yalnız bu günlük sayaçları kaldırır; planın kullanım hakkı (kota)
// ona bağlı değildir ve her zaman geçerlidir.

// Veritabanındaki mutlak üst sınır (CHECK).
export const APPROVE_ABOVE_ABSOLUTE_MAX_USD = 100;

export function monthlyAiBudgetUsd(planKey: PlanKey): number {
  return PLANS[planKey].quota.AI_MICROS / 1_000_000;
}

export type UserLimitRanges = {
  approveAbove: { min: number; max: number; planDefault: number | null };
  // null: bir üst sınır yok.
  dailyBudgetMax: number | null;
};

export function userLimitRanges(planKey: PlanKey | null): UserLimitRanges {
  if (!planKey) {
    return {
      approveAbove: {
        min: APPROVE_ABOVE_MIN_USD,
        max: APPROVE_ABOVE_ABSOLUTE_MAX_USD,
        planDefault: null,
      },
      dailyBudgetMax: null,
    };
  }
  const range = approveAboveRange(planKey);
  return {
    approveAbove: {
      min: range.min,
      max: Math.min(range.max, APPROVE_ABOVE_ABSOLUTE_MAX_USD),
      planDefault: range.planDefault,
    },
    dailyBudgetMax: monthlyAiBudgetUsd(planKey),
  };
}

export function clampUserLimits(input: {
  planKey: PlanKey | null;
  approveAboveUsd: number | null;
  dailyBudgetUsd: number | null;
}): { approveAboveUsd: number | null; dailyBudgetUsd: number | null } {
  const ranges = userLimitRanges(input.planKey);
  const approveAboveUsd =
    input.approveAboveUsd === null
      ? null
      : input.planKey
        ? Math.min(
            ranges.approveAbove.max,
            effectiveApproveAbove(input.planKey, input.approveAboveUsd),
          )
        : Math.min(
            APPROVE_ABOVE_ABSOLUTE_MAX_USD,
            Math.max(APPROVE_ABOVE_MIN_USD, input.approveAboveUsd),
          );
  const dailyBudgetUsd =
    input.dailyBudgetUsd === null || ranges.dailyBudgetMax === null
      ? input.dailyBudgetUsd
      : Math.min(input.dailyBudgetUsd, ranges.dailyBudgetMax);
  return {
    approveAboveUsd:
      approveAboveUsd === null ? null : Math.round(approveAboveUsd * 100) / 100,
    dailyBudgetUsd,
  };
}
