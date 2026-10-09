import { TASK_CEILING, type PlanKey } from "./plans";

// Onay eşiği (Faz 3C): sistemin KENDİ başlattığı bir görevin tahmini maliyeti, planın
// (ya da kullanıcının seçtiği) eşiğini aşarsa görev insan onayı bekler (L3). Kullanıcının
// kendi isteği asla bu eşiğe takılmaz. Saf ve izomorfik; kullanıcıya dolar değil
// "N görsel hakkı" gösterilir (müşteri metni sayı ve yüzde konuşur).
//
// Rakamlar BAŞLANGIÇ HİPOTEZİDİR (UsageEntry verisiyle ayarlanır).

// Paket varsayılanı (USD): bir görev bunun üstünde tahmin edilirse onay ister.
export const APPROVE_ABOVE_USD: Readonly<Record<PlanKey, number>> = {
  starter: 0.5,
  growth: 1,
  business: 1.5,
  agency: 2.5,
};

// Kullanıcı eşiği paket varsayılanının [MIN, varsayılan x MAX_FACTOR] aralığında seçer;
// aralığın dışı sınıra çekilir.
export const APPROVE_ABOVE_MIN_USD = 0.1;
export const APPROVE_ABOVE_MAX_FACTOR = 5;

// Bir görselin tahmini ortalama maliyeti (metin + art direction + çizim, yüksek kalite
// dahil ≈ $0,4; TASK_CEILING.perImageUsd emniyet tavanıdır, tahmin değil).
export const ESTIMATED_IMAGE_COST_USD = 0.4;

export type ApproveAboveRange = {
  min: number;
  max: number;
  planDefault: number;
};

export function approveAboveRange(planKey: PlanKey): ApproveAboveRange {
  const planDefault = APPROVE_ABOVE_USD[planKey];
  return {
    min: APPROVE_ABOVE_MIN_USD,
    max: planDefault * APPROVE_ABOVE_MAX_FACTOR,
    planDefault,
  };
}

// Etkin eşik: kullanıcı seçtiyse aralığa çekilmiş hâli, seçmediyse paket varsayılanı.
export function effectiveApproveAbove(
  planKey: PlanKey,
  chosen: number | null | undefined,
): number {
  const range = approveAboveRange(planKey);
  if (chosen === null || chosen === undefined || !Number.isFinite(chosen)) {
    return range.planDefault;
  }
  return Math.min(range.max, Math.max(range.min, chosen));
}

// İşin hak ihtiyacından (görsel adedi ya da mikro-dolar) tahmini USD.
export function estimateCostUsd(need: {
  unit: "IMAGE" | "VIDEO" | "AI_MICROS";
  amount: bigint | number;
}): number {
  const amount = Number(need.amount);
  if (need.unit === "AI_MICROS") return amount / 1_000_000;
  if (need.unit === "IMAGE") return amount * ESTIMATED_IMAGE_COST_USD;
  // Video satılmaz (VIDEO_SELLABLE=false); satılırsa görselden pahalı varsay.
  return amount * TASK_CEILING.perImageUsd * 4;
}

// Onay kartındaki satırın başlığı; cümle costApprovalNote'tur.
export const COST_APPROVAL_LABEL = "Why you are asked";

export function costApprovalDetails(
  note: string | undefined,
): Array<{ label: string; value: string }> | undefined {
  return note ? [{ label: COST_APPROVAL_LABEL, value: note }] : undefined;
}

// Onay kartında gösterilecek cümle: dolar değil hak.
export function costApprovalNote(need: {
  unit: "IMAGE" | "VIDEO" | "AI_MICROS";
  amount: bigint | number;
}): string {
  if (need.unit === "IMAGE") {
    const images = Number(need.amount);
    return `This automatic task would use ${images} post ${images === 1 ? "image" : "images"} of your plan, more than the size you chose to approve on your own.`;
  }
  return "This automatic task would use a large share of your AI assistant usage, more than the size you chose to approve on your own.";
}
