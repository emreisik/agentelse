import "server-only";

import {
  isSeoLanguage,
  seoLanguageName,
} from "@/lib/module-flows/seo/brief";
import type { SeoBrief } from "@/lib/module-flows/seo/state";
import { SeoActionFlags } from "@/lib/seo/action-flags";
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

// ruleLanguage: markanın kurallarının yazıldığı dil (brief dilinden farklı
// olabilir). Yalnız verilince eklenir; verilmezse bugünkü çıktı aynen kalır.
export function briefFacts(
  brief: SeoBrief,
  options: { ruleLanguage?: string } = {},
): Record<string, unknown> {
  return {
    topic: brief.topic,
    siteUrl: brief.siteUrl || null,
    audience: brief.audience || null,
    language: { code: brief.language, name: seoLanguageName(brief.language) },
    ...(options.ruleLanguage ? { ruleLanguage: options.ruleLanguage } : {}),
  };
}

const MAX_LEARNINGS = 5;
const LEARNING_CHARS = 240;

// Sitenin geçmiş SEO sonuçları (sayı içermeyen şablon metinler); boşsa hiç
// eklenmez.
function learningTexts(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim().slice(0, LEARNING_CHARS);
    if (text) out.push(text);
    if (out.length >= MAX_LEARNINGS) break;
  }
  return out;
}

// Brief dili sert kuraldır (SC-F6): SEO_ACTIONS açıkken ReasoningInput.language
// olarak gider ve yerel yönergeyi ezer. Desteklenmeyen değer yok sayılır;
// bayrak kapalıyken hiçbir şey eklenmez (bugünkü çağrı aynen kalır).
export function languageInput(
  language: string | undefined,
): { language?: string } {
  if (!SeoActionFlags.manager()) return {};
  return language && isSeoLanguage(language) ? { language } : {};
}

// Geçmiş sonuç satırları da yalnız bayrak açıkken istemlere girer.
export function learningsInput(
  learnings: readonly string[] | undefined,
): { learnings?: readonly string[] } {
  return SeoActionFlags.manager() && learnings?.length ? { learnings } : {};
}

// Marka kurallarının yazıldığı dil: yalnız SEO_ACTIONS açıkken okunur (istem
// "kurallar şu dilde, yazı brief dilinde" der); kapalıyken undefined.
export async function ruleLanguageInput(
  projectId: string,
): Promise<string | undefined> {
  return SeoActionFlags.manager()
    ? brandRuleLanguageOf(projectId)
    : undefined;
}

export async function brandFacts(
  scope: SeoScope,
  options: {
    rules: boolean;
    learnings?: readonly string[];
    // Çağıran kural dilini zaten okuduysa ikinci bir sorgu atılmaz.
    ruleLanguage?: string;
  },
): Promise<Record<string, unknown>> {
  const learnings = learningTexts(options.learnings);
  const [twin, rules] = await Promise.all([
    getBrandTwin(scope.projectId, { memory: false }).catch(() => null),
    options.rules
      ? (options.ruleLanguage
          ? Promise.resolve(options.ruleLanguage)
          : brandRuleLanguageOf(scope.projectId)
        ).then((language) =>
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
    ...(learnings.length > 0 ? { seoLearnings: learnings } : {}),
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
