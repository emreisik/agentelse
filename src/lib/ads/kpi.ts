// KPI hedefi (docs/meta-ads-plan.md §3.3 "KPI hedefi"). Başabaş CPL = satış
// değeri × kapanış oranı × pazarlama payı (varsayılan %30); hedef CPL
// başabaşın %70'i. Hedef CPA için kapanış oranı 1'dir. Kullanıcı doğrudan
// "Max cost per lead" da girebilir. Saf; tutarlar ana birimde.

export const DEFAULT_MARKETING_SHARE = 0.3;
export const TARGET_OF_BREAKEVEN = 0.7;

export type KpiInput =
  | {
      mode: "value";
      // Ortalama satış değeri (ana birim).
      saleValue: number;
      // "10 lead ya da sohbetten kaçı müşteri olur?" (0-10).
      closeOutOfTen: number;
      marketingShare?: number;
    }
  | { mode: "max"; maxCost: number };

export function breakevenCost(input: Extract<KpiInput, { mode: "value" }>): number {
  const share = input.marketingShare ?? DEFAULT_MARKETING_SHARE;
  return input.saleValue * (input.closeOutOfTen / 10) * share;
}

// Hedef maliyet (ana birim) ya da null (girilmedi / anlamsız).
export function targetCost(input: KpiInput | undefined): number | null {
  if (!input) return null;
  if (input.mode === "max") {
    return Number.isFinite(input.maxCost) && input.maxCost > 0 ? input.maxCost : null;
  }
  if (!(input.saleValue > 0) || !(input.closeOutOfTen > 0)) return null;
  const target = breakevenCost(input) * TARGET_OF_BREAKEVEN;
  return Math.round(target * 100) / 100;
}

export type KpiMetric = "CPL" | "CPA" | "COST_PER_CONVERSATION" | "COST_PER_CLICK";

// Sonuç türünden KPI adı ve ProjectGoal metricKey'i.
export function kpiMetricFor(resultActionType: string | null): {
  metric: KpiMetric;
  metricKey: string;
  label: string;
} {
  if (resultActionType === "lead" || resultActionType === "offsite_conversion.fb_pixel_lead") {
    return { metric: "CPL", metricKey: "ads.cpl", label: "cost per lead" };
  }
  if (resultActionType === "onsite_conversion.messaging_conversation_started_7d") {
    return { metric: "COST_PER_CONVERSATION", metricKey: "ads.cost_per_conversation", label: "cost per conversation" };
  }
  if (resultActionType === "link_click" || resultActionType === "landing_page_view") {
    return { metric: "COST_PER_CLICK", metricKey: "ads.cost_per_click", label: "cost per visit" };
  }
  return { metric: "CPA", metricKey: "ads.cpa", label: "cost per result" };
}

// Öğrenme fizibilitesi: haftada ~50 sonuç gerekir; günlük bütçe hedef ×
// 50/7'nin altındaysa ad set büyük olasılıkla "learning limited" kalır.
export function learningFeasible(dailyBudget: number, target: number | null): boolean {
  if (!target || !(target > 0)) return true;
  return dailyBudget >= (target * 50) / 7;
}

export function learningBudget(target: number): number {
  return Math.ceil((target * 50) / 7);
}
