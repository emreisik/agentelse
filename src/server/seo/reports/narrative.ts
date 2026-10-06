import "server-only";

import { checkSummaryNumbers } from "@/lib/module-flows/analytics/number-check";
import type { ReportSummary } from "@/lib/module-flows/analytics/report";
import {
  narrativeAllowedNumbers,
  seoNarrativeFacts,
} from "@/lib/seo/reports/facts";
import { NARRATIVE_NOTE } from "@/lib/seo/reports/text";
import type { SeoReportSnapshot } from "@/lib/seo/reports/types";
import { limitNoticeFromError } from "@/server/commands/limit-notice";
import { cleanSummary } from "@/server/modules/analytics/summary";
import { seoReportNarrativeDef } from "@/server/reasoning/prompts/seo-report-narrative";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

// SEO raporunun anlatısı (docs/search-reports.md "Anlatı"): haftalık ve aylık
// rapor başına TEK LLM çağrısı. Modele yalnız toplu rakamlar ve en çok 20
// maskeli Google metni gider (seoNarrativeFacts); cevap temizlenir ve veride
// olmayan rakam yazan her cümle atılır (işaretten bağımsız izinli sayılar).
// Mock kipte ve sahte bağda sahte cevap ASLA saklanmaz, çağrı da yapılmaz.
// Hata mesajı loga girmez: ReasoningService ve zod hataları modelin yazdığı
// (Google metni içerebilen) metni taşıyabilir; yalnız hata adı yazılır.

export type NarrativeScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export function narrativeNoteForError(error: unknown): string {
  const reason = limitNoticeFromError(error)?.reason;
  return reason === "daily-budget" || reason === "daily-reasoning"
    ? NARRATIVE_NOTE.budget
    : NARRATIVE_NOTE.failed;
}

// Hiçbir zaman fırlatmaz: anlatı olmadan da rapor geçerlidir.
export async function writeSeoNarrative(
  scope: NarrativeScope,
  snapshot: SeoReportSnapshot,
  options: { mockLink: boolean },
): Promise<{ narrative: ReportSummary | null; note: string | null }> {
  if (snapshot.kind !== "WEEKLY" && snapshot.kind !== "MONTHLY") {
    return { narrative: null, note: null };
  }
  if (options.mockLink || ReasoningService.isMockMode()) {
    return { narrative: null, note: NARRATIVE_NOTE.mock };
  }
  try {
    const { facts } = seoNarrativeFacts(snapshot);
    const { output } = await ReasoningService.run(seoReportNarrativeDef, {
      ...scope,
      context: { facts },
    });
    const checked = checkSummaryNumbers(
      cleanSummary(output),
      narrativeAllowedNumbers(facts),
    );
    return checked
      ? { narrative: checked, note: null }
      : { narrative: null, note: NARRATIVE_NOTE.dropped };
  } catch (error) {
    console.error(
      "[seo-reports] narrative failed:",
      error instanceof Error ? error.name : "unknown",
    );
    return { narrative: null, note: narrativeNoteForError(error) };
  }
}
