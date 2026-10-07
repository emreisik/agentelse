import "server-only";

import type { GaRange } from "@/lib/website-analytics/analysis/types";
import { gaAttributionEnabledFor } from "@/lib/website-analytics/attribution/flags";
import { agentelseReportSection } from "@/lib/website-analytics/attribution/report-section";
import type { ReportAgentelseSection } from "@/lib/website-analytics/reports/types";
import { loadWebsiteAttribution } from "@/server/website-analytics/attribution/read";

// GA-F6: haftalık raporun "From Agentelse" bölümü. Önce bayrak kapısı (kapalıyken
// sorgu yok); sonra hesaplama okuma anında yapılır. Hata rapor üretimini
// bozmamalı: bölüm null olur.
export async function loadAgentelseReportSection(input: {
  projectId: string;
  range: GaRange;
  gaCurrency: string | null;
}): Promise<ReportAgentelseSection | null> {
  if (!gaAttributionEnabledFor(input.projectId)) return null;
  try {
    const view = await loadWebsiteAttribution(input.projectId, input.range);
    if (!view) return null;
    return agentelseReportSection({ view, gaCurrency: input.gaCurrency });
  } catch {
    return null;
  }
}
