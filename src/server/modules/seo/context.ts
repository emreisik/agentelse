import "server-only";

import { seoLanguageName } from "@/lib/module-flows/seo/brief";
import type { SeoBrief } from "@/lib/module-flows/seo/state";
import { cleanWorksTextOrNull, flattenRuleText } from "@/lib/works/clean-text";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { loadBrandRules } from "@/server/works/brand-rule-loader";

// What the SEO Manager's model calls know about the brand and the brief
// (docs/modules.md "SEO Manager"): the same brand context the other Works calls
// send (master-content.ts), read fail-open so a cold database never blocks a
// card, and the one error mapping of a failed call.

export type SeoScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type SeoModelFailure = {
  ok: false;
  code: "MOCK" | "FAILED" | "BUDGET";
  message: string;
};

const MAX_RULES = 12;
const MAX_PRODUCTS = 8;
const MAX_AUDIENCES = 4;

function texts(values: readonly string[] | undefined, max: number): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const text = cleanWorksTextOrNull(value, 120);
    if (text) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// Rule text goes to the model flattened and clipped, never judged: the
// instruction filter would drop "Never mention competitors by name".
function ruleTexts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = flattenRuleText(value, 120);
    if (text) out.push(text);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

export function briefFacts(brief: SeoBrief): Record<string, unknown> {
  return {
    topic: brief.topic,
    siteUrl: brief.siteUrl || null,
    audience: brief.audience || null,
    language: { code: brief.language, name: seoLanguageName(brief.language) },
  };
}

export async function brandFacts(
  scope: SeoScope,
  options: { rules: boolean },
): Promise<Record<string, unknown>> {
  const [twin, rules] = await Promise.all([
    getBrandTwin(scope.projectId, { memory: false }).catch(() => null),
    options.rules
      ? brandRuleLanguageOf(scope.projectId).then((language) =>
          loadBrandRules({
            projectId: scope.projectId,
            brandId: scope.brandId,
            language,
          }),
        )
      : Promise.resolve(null),
  ]);
  return {
    brand: {
      name: cleanWorksTextOrNull(twin?.name, 80),
      positioning: cleanWorksTextOrNull(twin?.positioning, 240),
      valueProposition: cleanWorksTextOrNull(twin?.valueProposition, 240),
      products: texts(twin?.products, MAX_PRODUCTS),
      audience: texts(twin?.audience, MAX_AUDIENCES),
      voice: {
        personality: cleanWorksTextOrNull(twin?.voice.personality, 160),
        toneOfVoice: cleanWorksTextOrNull(twin?.voice.toneOfVoice, 160),
      },
    },
    ...(options.rules
      ? {
          neverRules: ruleTexts(rules?.never.map((rule) => rule.text) ?? []),
          approvedClaims: ruleTexts(rules?.approvedClaims ?? []),
        }
      : {}),
  };
}

export function modelFailure(
  label: string,
  error: unknown,
  fallback: string,
): SeoModelFailure {
  const notice = limitNoticeFromError(error);
  if (notice) {
    return { ok: false, code: "BUDGET", message: limitNoticeReplyText(notice) };
  }
  console.error(
    `[works] seo ${label} failed:`,
    error instanceof Error ? error.message : error,
  );
  return { ok: false, code: "FAILED", message: fallback };
}
