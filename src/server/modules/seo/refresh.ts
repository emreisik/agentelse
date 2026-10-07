import "server-only";

import { planFromResearch, cleanModelLine } from "@/lib/module-flows/seo/plan";
import type { SeoPromptQuery } from "@/lib/module-flows/seo/snippet";
import type {
  SeoBrief,
  SeoPlan,
  SeoRefresh,
  SeoTarget,
} from "@/lib/module-flows/seo/state";
import { foldForMatch } from "@/lib/text-fold";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { seoRefreshResearchDef } from "@/server/reasoning/prompts/seo-refresh";

import {
  brandFacts,
  briefFacts,
  languageInput,
  learningsInput,
  modelFailure,
  type SeoModelFailure,
  type SeoScope,
} from "./context";
import { promptQueries, targetFacts } from "./snippet";

// SEO Manager "Refresh a page" kipinin araştırma adımı (SC-F6): TEK model
// çağrısı (canlı web aramasıyla), var olan sayfa için plan + eksik alt konular
// + korunacaklar. Hiçbir şey yazmaz; kartı yazan eylem çağıran taraftadır.
// Marka kuralları yüklenmez (araştırma çağrısı kural istemez), bu yüzden kural
// dili de eklenmez. Plan'ın quickWins'i her zaman not-connected: karta hiçbir sorgu dizesi
// girmez (Google verisi kartta kalmaz).

export const SEO_REFRESH_COPY = {
  failed: "Couldn't research this page. Try again.",
  thin: "The research came back incomplete. Try again.",
} as const;

// Sayfanın kendi metni (Google verisi değil) modele en çok bu kadar gider.
const PAGE_TEXT_CHARS = 6000;
const LIST_MAX = 8;

function cleanList(raw: readonly unknown[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = cleanModelLine(item, 120);
    const key = foldForMatch(text).trim();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export async function runSeoRefreshResearch(input: {
  scope: SeoScope;
  brief: SeoBrief;
  target: SeoTarget;
  pageText: string | null;
  queries: SeoPromptQuery[];
  learnings: string[];
  now?: Date;
}): Promise<
  { ok: true; plan: SeoPlan; refresh: SeoRefresh } | SeoModelFailure
> {
  const { scope, brief, target } = input;
  try {
    const brand = await brandFacts(scope, {
      rules: false,
      ...learningsInput(input.learnings),
    });
    const pageText = input.pageText?.slice(0, PAGE_TEXT_CHARS) ?? "";
    const { output } = await ReasoningService.run(seoRefreshResearchDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      ...languageInput(brief.language),
      context: {
        facts: {
          ...briefFacts(brief),
          ...brand,
          target: targetFacts(target),
          queries: promptQueries(input.queries),
          ...(pageText ? { currentText: pageText } : {}),
        },
      },
    });

    const plan = planFromResearch(
      output,
      { state: "not-connected" },
      input.now ?? new Date(),
    );
    if (!plan) {
      return { ok: false, code: "FAILED", message: SEO_REFRESH_COPY.thin };
    }
    return {
      ok: true,
      plan,
      refresh: {
        missing: cleanList(output.missingSubtopics, LIST_MAX),
        keep: cleanList(output.keep, LIST_MAX),
      },
    };
  } catch (error) {
    return modelFailure("refresh", error, SEO_REFRESH_COPY.failed);
  }
}
