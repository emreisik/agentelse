import "server-only";

import {
  cleanSnippetVariants,
  type SeoPromptQuery,
} from "@/lib/module-flows/seo/snippet";
import type {
  SeoBrief,
  SeoSnippet,
  SeoTarget,
} from "@/lib/module-flows/seo/state";
import { maskGooglePath, maskGoogleText } from "@/server/integrations/google/pii";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { seoSnippetDef } from "@/server/reasoning/prompts/seo-snippet";

import {
  brandFacts,
  briefFacts,
  languageInput,
  learningsInput,
  modelFailure,
  ruleLanguageInput,
  type SeoModelFailure,
  type SeoScope,
} from "./context";

// SEO Manager "Fix a snippet" kipinin sunucu tarafı (SC-F6): TEK model
// çağrısı, sayfanın başlık/meta'sı için üç varyant. Hiçbir şey yazmaz: kartı
// yazan eylem (claim + kart yazımı) çağırandadır, hata kartı olduğu gibi bırakır.
// Modele giden Google dizgisi: en çok 10 maskelenmiş sorgu + 1 maskelenmiş yol.

export const SEO_SNIPPET_COPY = {
  failed: "Couldn't write new titles. Try again.",
  thin: "The suggestions came back unusable. Try again.",
} as const;

const MAX_QUERIES = 10;
const MAX_H2 = 20;

export function promptQueries(
  queries: readonly SeoPromptQuery[],
): { text: string; impressions: number; clicks: number; position: number | null }[] {
  const out: SeoPromptQuery[] = [];
  for (const query of queries) {
    const text = maskGoogleText(query.text);
    if (!text) continue;
    out.push({
      text,
      impressions: query.impressions,
      clicks: query.clicks,
      position:
        query.position === null ? null : Math.round(query.position * 10) / 10,
    });
    if (out.length >= MAX_QUERIES) break;
  }
  return out;
}

export function targetFacts(target: SeoTarget): Record<string, unknown> {
  return {
    path: maskGooglePath(target.path),
    title: target.title,
    metaDescription: target.metaDescription,
    h1: target.h1,
    h2: target.h2.slice(0, MAX_H2),
  };
}

export async function runSeoSnippet(input: {
  scope: SeoScope;
  brief: SeoBrief;
  target: SeoTarget;
  queries: SeoPromptQuery[];
  learnings: string[];
  now?: Date;
}): Promise<{ ok: true; snippet: SeoSnippet } | SeoModelFailure> {
  const { scope, brief, target } = input;
  try {
    const ruleLanguage = await ruleLanguageInput(scope.projectId);
    const brand = await brandFacts(scope, {
      rules: true,
      ...(ruleLanguage ? { ruleLanguage } : {}),
      ...learningsInput(input.learnings),
    });
    const { output } = await ReasoningService.run(seoSnippetDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      ...languageInput(brief.language),
      context: {
        facts: {
          ...briefFacts(brief, ruleLanguage ? { ruleLanguage } : {}),
          ...brand,
          target: targetFacts(target),
          queries: promptQueries(input.queries),
        },
      },
    });

    const variants = cleanSnippetVariants(output.variants, {
      title: target.title,
      metaDescription: target.metaDescription,
    });
    if (variants.length === 0) {
      return { ok: false, code: "FAILED", message: SEO_SNIPPET_COPY.thin };
    }
    return {
      ok: true,
      snippet: {
        variants,
        chosen: null,
        edited: null,
        generatedAt: (input.now ?? new Date()).toISOString(),
      },
    };
  } catch (error) {
    return modelFailure("snippet", error, SEO_SNIPPET_COPY.failed);
  }
}
