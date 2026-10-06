import "server-only";

import {
  gaInsightsMode,
  gaInsightsProjects,
} from "@/lib/website-analytics/analysis/flags";

// GA-F4 tarayıcı kapısı (docs/website-insights.md "Yerine geçen"): eski
// google-analytics-scanner'ın GA kısmı GA_INSIGHTS=on iken bütünüyle, gölge
// modda yalnız GA_INSIGHTS_PROJECTS projelerinde atlanır (düşüşleri AN1/AN2
// bulur). Kapalıyken sağlayıcı listesi aynen döner.
export function scannerGaGate<T extends string>(
  providers: readonly T[],
  gaProvider: T,
): { providers: T[]; excludeGaProjectIds: string[] } {
  const base = gaInsightsMode();
  if (base === "on") {
    return {
      providers: providers.filter((provider) => provider !== gaProvider),
      excludeGaProjectIds: [],
    };
  }
  if (base === "shadow") {
    return {
      providers: [...providers],
      excludeGaProjectIds: gaInsightsProjects(),
    };
  }
  return { providers: [...providers], excludeGaProjectIds: [] };
}
