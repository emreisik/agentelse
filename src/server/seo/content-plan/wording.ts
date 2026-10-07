import "server-only";

import { limitGoogleStrings } from "@/lib/seo/llm-budget";
import { cleanWording, type CleanWording } from "@/lib/seo/content-plan/titles";
import type {
  PlanCandidate,
  PlanWording,
} from "@/lib/seo/content-plan/types";
import { blocksOf, checkText } from "@/lib/works/brand-rules";
import { flattenRuleText } from "@/lib/works/clean-text";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { maskGoogleText } from "@/server/integrations/google/pii";
import {
  seoContentPlanDef,
  type SeoContentPlanOutput,
} from "@/server/reasoning/prompts/seo-content-plan";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isAgentelseError } from "@/server/security/errors";
import { loadBrandRules } from "@/server/works/brand-rule-loader";

import type { SlotScope } from "./pieces";

// Plan metni (docs/search-content-plan.md "Plan nasıl kurulur" 8): plan ya da
// yenileme başına TEK lite çağrı. Modele giden Google dizgileri en çok 20
// farklı ve maskeli olandır (anahtar kelimeler önce, destekleyici sorgular
// sonra); maskelemede değişen dizge gitmez. Dönen her başlık temizlenir
// (cleanWording: anahtar kelime sözcüğü, uydurma rakam yok), marka kurallarından
// geçer; geçmeyen öğe düşer ve planlayıcı temel başlığı koyar. Bütçe dolarsa
// ya da çağrı başarısız olursa BASIC; mock modda model hiç çağrılmaz, sahte
// metin MOCK sayılır.

export const WORDING_STRING_LIMIT = 20;
const RULES_MAX = 20;

export type WordingContext = {
  candidates: {
    id: string;
    kind: string;
    intent: string;
    keyword: string;
    queries: string[];
  }[];
};

type Entry = { id: string; role: "keyword" | "query"; text: string };

// Anahtar kelimeler önce, sonra destekleyici sorgular; her dizge maskelenir ve
// maskelemede değişiyorsa atılır. Anahtar kelimesi sığmayan aday bağlama girmez
// (temel metni alır).
export function wordingContext(
  candidates: readonly PlanCandidate[],
): WordingContext {
  const entries: Entry[] = [];
  const keywordOk = (text: string) => maskGoogleText(text) === text;
  for (const candidate of candidates) {
    if (keywordOk(candidate.keyword)) {
      entries.push({ id: candidate.id, role: "keyword", text: candidate.keyword });
    }
  }
  for (const candidate of candidates) {
    for (const query of candidate.queries) {
      if (keywordOk(query)) {
        entries.push({ id: candidate.id, role: "query", text: query });
      }
    }
  }
  const limited = limitGoogleStrings(entries, (entry) => [entry.text], {
    limit: WORDING_STRING_LIMIT,
  });
  const keywords = new Map<string, string>();
  const queries = new Map<string, string[]>();
  for (const entry of limited.items) {
    if (entry.role === "keyword") keywords.set(entry.id, entry.text);
    else queries.set(entry.id, [...(queries.get(entry.id) ?? []), entry.text]);
  }
  const out: WordingContext["candidates"] = [];
  for (const candidate of candidates) {
    const keyword = keywords.get(candidate.id);
    if (keyword === undefined) continue;
    out.push({
      id: candidate.id,
      kind: candidate.kind,
      intent: candidate.intent,
      keyword,
      queries: queries.get(candidate.id) ?? [],
    });
  }
  return { candidates: out };
}

export type WordingResult = {
  wording: PlanWording;
  // Yalnız geçerli model/sahte metinleri (aday kimliği -> metin); eksik aday
  // temel metni alır.
  items: Map<string, CleanWording>;
  budgetHit: boolean;
};

function isBudgetError(error: unknown): boolean {
  return isAgentelseError(error) && error.code === "BUDGET_EXCEEDED";
}

async function brandRulesOf(scope: SlotScope) {
  const language = await brandRuleLanguageOf(scope.projectId);
  return loadBrandRules({
    projectId: scope.projectId,
    brandId: scope.brandId,
    language,
  });
}

export async function writeWording(input: {
  scope: SlotScope;
  candidates: readonly PlanCandidate[];
  language: string | null;
  now: Date;
}): Promise<WordingResult> {
  const { scope, candidates } = input;
  const basic = (budgetHit = false): WordingResult => ({
    wording: "BASIC",
    items: new Map(),
    budgetHit,
  });
  if (candidates.length === 0) return basic();

  const context = wordingContext(candidates);
  if (context.candidates.length === 0) return basic();
  const sent = candidates.filter((candidate) =>
    context.candidates.some((item) => item.id === candidate.id),
  );
  const rules = await brandRulesOf(scope);

  let output: SeoContentPlanOutput;
  let wording: PlanWording;
  if (ReasoningService.isMockMode()) {
    // Mock modda model çağrılmaz (bütçe/denetim yan etkisi yok): sahte çıktı
    // aynı doğrulamadan geçer.
    output = seoContentPlanDef.buildMock({ ...context });
    wording = "MOCK";
  } else {
    try {
      const brand = await ConstitutionService.getBrandContext(
        scope.brandId,
      ).catch(() => ({}));
      const run = await ReasoningService.run(seoContentPlanDef, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        context: {
          ...context,
          brand,
          rules: (rules?.never ?? [])
            .map((rule) => flattenRuleText(rule.text))
            .filter((rule): rule is string => rule !== null)
            .slice(0, RULES_MAX),
        },
      });
      output = run.output;
      wording = run.isMock ? "MOCK" : "AI";
    } catch (error) {
      if (isBudgetError(error)) return basic(true);
      // Hata metni Google dizgisi taşıyabilir: yalnız adı yazılır.
      console.error(
        "[seo-content-plan] wording failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
      return basic();
    }
  }

  const cleaned = cleanWording(output, sent);
  const items = new Map<string, CleanWording>();
  for (const [id, item] of cleaned) {
    const texts = [item.title, item.angle, item.description].filter(Boolean);
    const blocked = texts.some(
      (text) => blocksOf(checkText(text, rules)).length > 0,
    );
    if (!blocked) items.set(id, item);
  }
  return { wording, items, budgetHit: false };
}
