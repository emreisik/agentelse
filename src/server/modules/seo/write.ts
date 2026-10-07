import "server-only";

import { cleanLine } from "@/lib/module-flows/seo/brief";
import { countWords } from "@/lib/module-flows/seo/markdown";
import { checkOnPage, onPageWarnings } from "@/lib/module-flows/seo/on-page";
import {
  chosenTitle,
  cleanModelLine,
  normalizeArticleMarkdown,
} from "@/lib/module-flows/seo/plan";
import {
  SEO_LIMITS,
  type SeoArticle,
  type SeoBrief,
  type SeoPlan,
} from "@/lib/module-flows/seo/state";
import { ReasoningService } from "@/server/reasoning/reasoning-service";

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
import { seoArticleDef } from "./prompts";

// The SEO Manager's Create step (and Rewrite on Review) on the server
// (docs/modules.md "SEO Manager"): ONE model call that writes the article from
// the plan, in the brand's voice and the brief's language. Never writes: the
// action owns the claim and the card write.

// An answer this short is a broken one, not a short article.
const MIN_WORDS = 200;

export const SEO_WRITE_COPY = {
  failed: "Couldn't write the article. Try again.",
  rewriteFailed: "Couldn't rewrite the article. Try again.",
  short: "The article came back too short. Try again.",
} as const;

export type SeoDraft = Pick<
  SeoArticle,
  "title" | "metaDescription" | "markdown"
>;

// Tazelenen sayfanın bugünkü hali: kendi sitemizden okunan metin (en çok 6.000
// karakter) ve başlıklar; Google verisi değildir. missing/keep tazeleme
// araştırmasının çıktısıdır.
export type SeoCurrentPage = {
  text: string | null;
  title: string | null;
  h2: string[];
  missing?: string[];
  keep?: string[];
};

const CURRENT_TEXT_CHARS = 6000;

type WriteInput = {
  scope: SeoScope;
  brief: SeoBrief;
  plan: SeoPlan;
  // SEO_ACTIONS açıkken kullanılır; kapalıyken yok sayılır.
  language?: string;
  learnings?: string[];
} & (
  | { mode: "write" }
  | { mode: "rewrite"; article: SeoArticle; notes: string }
  | { mode: "refresh"; current?: SeoCurrentPage }
);

function planFacts(plan: SeoPlan): Record<string, unknown> {
  return {
    keywords: {
      primary: plan.primaryKeyword,
      secondary: plan.secondaryKeywords,
      searchIntent: plan.searchIntent,
      intentNote: plan.intentNote || null,
    },
    outline: plan.outline,
  };
}

export async function runSeoWrite(
  input: WriteInput,
): Promise<{ ok: true; draft: SeoDraft } | SeoModelFailure> {
  const { scope, brief, plan } = input;
  const rewrite = input.mode === "rewrite";
  const refresh = input.mode === "refresh";
  const title = rewrite ? input.article.title : chosenTitle(plan);
  const metaDescription = rewrite
    ? input.article.metaDescription
    : plan.metaDescription;

  try {
    const ruleLanguage = await ruleLanguageInput(scope.projectId);
    const brand = await brandFacts(scope, {
      rules: true,
      ...(ruleLanguage ? { ruleLanguage } : {}),
      ...learningsInput(input.learnings),
    });
    const facts: Record<string, unknown> = {
      ...briefFacts(brief, ruleLanguage ? { ruleLanguage } : {}),
      ...planFacts(plan),
      title,
      metaDescription,
      ...brand,
    };
    if (input.mode === "rewrite") {
      facts.article = {
        title,
        metaDescription,
        markdown: input.article.markdown,
      };
      facts.warnings = onPageWarnings(
        checkOnPage({
          title,
          metaDescription,
          markdown: input.article.markdown,
          primaryKeyword: plan.primaryKeyword,
        }),
      ).map((check) => `${check.label}: ${check.line}`);
    }

    if (input.mode === "refresh" && input.current) {
      const { current } = input;
      facts.current = {
        title: current.title,
        h2: current.h2.slice(0, 20),
        text: current.text?.slice(0, CURRENT_TEXT_CHARS) ?? "",
        missing: current.missing?.slice(0, 8) ?? [],
        keep: current.keep?.slice(0, 8) ?? [],
      };
    }

    const { output } = await ReasoningService.run(seoArticleDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      ...languageInput(input.language ?? brief.language),
      context: {
        facts,
        mode: input.mode,
        ...(input.mode === "rewrite"
          ? { notes: cleanLine(input.notes, SEO_LIMITS.notes) }
          : {}),
      },
    });

    const markdown = normalizeArticleMarkdown(output.markdown);
    if (countWords(markdown) < MIN_WORDS) {
      return { ok: false, code: "FAILED", message: SEO_WRITE_COPY.short };
    }
    return {
      ok: true,
      draft: {
        title:
          ((rewrite || refresh) &&
            cleanModelLine(output.title, SEO_LIMITS.title)) ||
          title,
        metaDescription:
          ((rewrite || refresh) &&
            cleanModelLine(output.metaDescription, SEO_LIMITS.meta)) ||
          metaDescription,
        markdown,
      },
    };
  } catch (error) {
    return modelFailure(
      input.mode,
      error,
      rewrite ? SEO_WRITE_COPY.rewriteFailed : SEO_WRITE_COPY.failed,
    );
  }
}
