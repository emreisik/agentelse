import "server-only";

import type { GscSiteLink } from "@prisma/client";

import { addWeeks } from "@/lib/seo/dates";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import { readPeriodCoverage } from "@/server/seo/store";

import { suggestBrandTermsForLink } from "./brand-suggest";
import { explainWeek } from "./explain";
import { ingestOpportunitySignals } from "./signals";
import { OUTPUTS_MIN_REMAINING_MS, readEngineState } from "./state";

// SC-F4 motorunun kullanıcıya dönük çıktıları (docs/search-opportunities.md
// "Zamanlama"): yalnız SEO_INSIGHTS=on iken, koşunun süresi bitmeden en az
// 20 sn kala; açıklama, sinyal ve marka terimi önerisi sırayla ve her biri
// kendi try/catch'iyle. Hepsi idempotenttir: süre yetmezse sonraki koşu
// tamamlar. Asla atmaz.

const BRAND_SUGGEST_MIN_WEEKS = 4;

function timeLeft(deadline: number): boolean {
  return Date.now() < deadline - OUTPUTS_MIN_REMAINING_MS;
}

function logFailure(step: string, error: unknown): void {
  console.warn(
    `[seo-opportunities] ${step} failed:`,
    error instanceof Error ? error.message : "unknown error",
  );
}

export async function publishOpportunityOutputs(input: {
  link: Pick<GscSiteLink, "id" | "projectId" | "workspaceId">;
  week: string;
  periodKey: string;
  now: Date;
  deadline: number;
}): Promise<{ explained: number; signals: number; budgetHit: boolean }> {
  const result = { explained: 0, signals: 0, budgetHit: false };
  try {
    if (!SeoInsightFlags.userFacing()) return result;
    if (timeLeft(input.deadline)) {
      try {
        const explained = await explainWeek({
          link: input.link,
          week: input.week,
          now: input.now,
        });
        result.explained = explained.explained;
        result.budgetHit = explained.budgetHit;
      } catch (error) {
        logFailure("explanations", error);
      }
    }
    if (timeLeft(input.deadline)) {
      try {
        result.signals = await ingestOpportunitySignals({
          link: input.link,
          periodKey: input.periodKey,
          now: input.now,
        });
      } catch (error) {
        logFailure("signals", error);
      }
    }
  } catch (error) {
    logFailure("outputs", error);
  }
  return result;
}

// Mod on iken ve bağın en az 4 tam haftası varken bir kez kendiliğinden
// (öneri durumu hiç yazılmamışsa); sonrası yalnız "Suggest terms" ile.
export async function maybeSuggestBrandTerms(input: {
  link: GscSiteLink;
  now: Date;
  deadline: number;
}): Promise<{ ran: boolean; budgetHit: boolean }> {
  const idle = { ran: false, budgetHit: false };
  try {
    const { link } = input;
    if (!SeoInsightFlags.userFacing()) return idle;
    if (!seoInsightsAllowedFor(link.projectId)) return idle;
    if (!timeLeft(input.deadline) || !link.lastWeeklyWeek) return idle;
    const state = await readEngineState(link.id);
    if (!state || state.brandSuggestions !== null) return idle;
    const coverage = await readPeriodCoverage(
      link.id,
      "WEEK",
      "query",
      addWeeks(link.lastWeeklyWeek, -(BRAND_SUGGEST_MIN_WEEKS - 1)),
      link.lastWeeklyWeek,
    );
    if (coverage.periods.length < BRAND_SUGGEST_MIN_WEEKS) return idle;
    if (!timeLeft(input.deadline)) return idle;
    const outcome = await suggestBrandTermsForLink({
      link,
      now: input.now,
      auto: true,
    });
    return {
      ran: outcome.ok,
      budgetHit: !outcome.ok && outcome.reason === "budget",
    };
  } catch (error) {
    logFailure("brand suggestions", error);
    return idle;
  }
}
