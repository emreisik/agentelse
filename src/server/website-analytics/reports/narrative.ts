import "server-only";

import type { ReportSummary } from "@/lib/module-flows/analytics/report";
import { checkSummaryNumbers } from "@/lib/module-flows/analytics/number-check";
import type { GaFindingView } from "@/lib/website-analytics/analysis/view-types";
import {
  needsNarrative,
  withNarrative,
} from "@/lib/website-analytics/reports/build";
import { WEBSITE_REPORT_COPY as COPY } from "@/lib/website-analytics/reports/copy";
import {
  narrativeAllowedNumbers,
  reportFactsOf,
} from "@/lib/website-analytics/reports/facts";
import type {
  NarrativeMode,
  NarrativeStatus,
  WebsiteReportCardData,
} from "@/lib/website-analytics/reports/types";
import { cleanSummary } from "@/server/modules/analytics/summary";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { gaReportNarrativeDef } from "@/server/reasoning/prompts/ga-report-narrative";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

import type { GaReportContext } from "./inputs";

// GA-F5 rapor anlatısı (docs/website-reports.md "Anlatı"): haftalık ve aylık
// rapor başına TEK LLM çağrısı. Modele yalnız toplu rakamlar ve en çok 20
// maskeli Google metni gider (facts.ts); cevap temizlenir ve veride olmayan
// rakam yazan her cümle atılır. Mock modda ya da demo bağında anlatı
// SAKLANMAZ (sahte cevap asla gerçek gibi saklanmaz); nedeni `note` söyler.
// Hata mesajı loga girmez: ReasoningService ve zod hataları modelin yazdığı
// (Google metni içerebilen) metni taşıyabilir.

export type NarrativeScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type NarrativeOutcome = {
  narrative: ReportSummary | null;
  note: string | null;
  status: NarrativeStatus;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

// Hiçbir zaman fırlatmaz: anlatı olmadan da rapor geçerlidir.
export async function writeReportNarrative(input: {
  scope: NarrativeScope;
  card: WebsiteReportCardData;
  findings: readonly GaFindingView[];
}): Promise<NarrativeOutcome> {
  const { scope, card, findings } = input;
  if (card.variant !== "weekly" && card.variant !== "monthly") {
    return { narrative: null, note: null, status: "none" };
  }
  if (card.isMock) {
    return { narrative: null, note: COPY.narrativeDemo, status: "demo" };
  }
  if (ReasoningService.isMockMode()) {
    return { narrative: null, note: COPY.narrativeMock, status: "mock" };
  }
  const built = reportFactsOf(card, findings);
  if (!built) return { narrative: null, note: null, status: "none" };

  try {
    const { output } = await ReasoningService.run(gaReportNarrativeDef, {
      ...scope,
      context: { facts: built.facts },
    });
    const checked = checkSummaryNumbers(
      cleanSummary(output),
      narrativeAllowedNumbers(built.facts),
    );
    return checked
      ? { narrative: checked, note: null, status: "ok" }
      : { narrative: null, note: COPY.narrativeDropped, status: "dropped" };
  } catch (error) {
    const notice = limitNoticeFromError(error);
    if (notice) {
      return {
        narrative: null,
        note: limitNoticeReplyText(notice),
        status: "budget",
      };
    }
    console.error("[ga-reports] narrative failed:", errorName(error));
    return { narrative: null, note: COPY.narrativeFailed, status: "error" };
  }
}

// Haftalık ve aylık yazarın ortak adımı: kipe göre anlatıyı yazar ya da
// atlar ve kartı anlatıyla birlikte döndürür. Anlatı gerekmiyorsa (demo bağ,
// mock mod) kip ne olursa olsun nedeni yazan çağrı yapılır; çağrı olmaz.
export async function narrateCard(input: {
  ctx: GaReportContext;
  card: WebsiteReportCardData;
  findings: readonly GaFindingView[];
  mode: NarrativeMode;
}): Promise<{ card: WebsiteReportCardData; status: NarrativeStatus }> {
  const { ctx, card, findings, mode } = input;
  const needed = needsNarrative(card, ReasoningService.isMockMode());
  let outcome: NarrativeOutcome;
  if (needed && (mode === "skip" || ctx.brandId === null)) {
    outcome = {
      narrative: null,
      note: COPY.narrativeFailed,
      status: "skipped",
    };
  } else {
    outcome = await writeReportNarrative({
      // Anlatı gerekmiyorsa (demo/mock) kapsam hiç kullanılmaz.
      scope: {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        brandId: ctx.brandId ?? "",
      },
      card,
      findings,
    });
  }
  return {
    card: withNarrative(card, {
      narrative: outcome.narrative,
      note: outcome.note,
    }),
    status: outcome.status,
  };
}
