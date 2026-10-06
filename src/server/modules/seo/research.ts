import "server-only";

import { planFromResearch } from "@/lib/module-flows/seo/plan";
import { pickQuickWins } from "@/lib/module-flows/seo/quick-wins";
import type {
  SeoBrief,
  SeoPlan,
  SeoQuickWins,
} from "@/lib/module-flows/seo/state";
import {
  SeoInsightFlags,
  seoInsightsAllowedFor,
} from "@/lib/seo/insight-flags";
import { pickCurveQuickWins } from "@/lib/seo/quick-wins-curve";
import { fetchSearchConsoleQueryRows } from "@/server/integrations/google-client";
import { findActiveGoogleConnections } from "@/server/integrations/google-connections";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { readSeoCurves } from "@/server/seo/opportunities/state";
import { readQuickWinRows } from "@/server/seo/readers";

import {
  brandFacts,
  briefFacts,
  modelFailure,
  type SeoModelFailure,
  type SeoScope,
} from "./context";
import { seoResearchDef } from "./prompts";

// The SEO Manager's Plan step on the server (docs/modules.md "SEO Manager"):
// ONE research call with live web search, and next to it the site's own
// Search Console queries that are close to page one. Never writes: the action
// owns the claim and the card write, so a failure leaves the card as it was.

// Search Console sorts rows by clicks; enough rows that a query seen often but
// rarely clicked (the quick win) is still among them.
const QUERY_ROWS = 1000;
const QUERY_DAYS = 28;

export const SEO_RESEARCH_COPY = {
  failed: "Couldn't research this topic. Try again.",
  thin: "The research came back incomplete. Try again.",
} as const;

// Never throws: no connection, an expired grant or an API error each end as a
// state the card can explain.
export async function loadSeoQuickWins(
  projectId: string,
): Promise<SeoQuickWins> {
  try {
    const { searchConsole } = await findActiveGoogleConnections(projectId);
    if (!searchConsole) return { state: "not-connected" };
    // Ambar (GSC_SYNC) son 4 tam haftayı kapsıyorsa Google'a gidilmez; yalnız
    // markasız sorgular. Okunamazsa ya da eksikse bugünkü canlı yol.
    const stored = await readQuickWinRows({
      projectId,
      siteUrl: searchConsole.siteUrl,
    }).catch(() => null);
    if (stored) {
      // SC-F4 (SEO_INSIGHTS=on): sitenin kendi CTR eğrisi varsa hızlı
      // kazanımlar pozisyon 4–20 arasından tahmini ek aylık tıklamaya göre
      // seçilir; eğri okunamazsa bugünkü seçim aynen kalır.
      if (SeoInsightFlags.userFacing() && seoInsightsAllowedFor(projectId)) {
        const curves = await readSeoCurves(projectId).catch(() => null);
        if (curves) {
          return {
            state: "ok",
            items: pickCurveQuickWins(stored, curves.nonBrand),
          };
        }
      }
      return { state: "ok", items: pickQuickWins(stored) };
    }
    const accessToken = await getFreshGoogleAccessToken(
      searchConsole.credential,
    );
    const rows = await fetchSearchConsoleQueryRows(
      accessToken,
      searchConsole.siteUrl,
      ["query"],
      QUERY_DAYS,
      QUERY_ROWS,
    );
    return { state: "ok", items: pickQuickWins(rows) };
  } catch (error) {
    console.error(
      "[works] seo quick wins failed:",
      error instanceof Error ? error.message : error,
    );
    return { state: "failed" };
  }
}

export async function runSeoResearch(input: {
  scope: SeoScope;
  brief: SeoBrief;
  now?: Date;
}): Promise<{ ok: true; plan: SeoPlan } | SeoModelFailure> {
  const { scope, brief } = input;
  // Search Console is read while the model researches (it never throws).
  const quickWins = loadSeoQuickWins(scope.projectId);
  try {
    const brand = await brandFacts(scope, { rules: false });
    const { output } = await ReasoningService.run(seoResearchDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      context: { facts: { ...briefFacts(brief), ...brand } },
    });
    const plan = planFromResearch(
      output,
      await quickWins,
      input.now ?? new Date(),
    );
    if (!plan) {
      return { ok: false, code: "FAILED", message: SEO_RESEARCH_COPY.thin };
    }
    return { ok: true, plan };
  } catch (error) {
    return modelFailure("research", error, SEO_RESEARCH_COPY.failed);
  }
}
