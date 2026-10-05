import "server-only";

import { countryLabel } from "@/lib/locales";
import {
  ADS_CTA_LABEL,
  ADS_GENDER_LABEL,
  ADS_LIMITS,
  ADS_OBJECTIVE_META,
  adTextFrom,
  ageRangeText,
  clipWords,
  defaultAdsPlan,
  linkDomain,
  type AdsBrief,
  type AdsPlan,
} from "@/lib/module-flows/ads/state";
import { blocksOf, checkText } from "@/lib/works/brand-rules";
import { cleanWorksTextOrNull, flattenRuleText } from "@/lib/works/clean-text";
import { getBrandTwin } from "@/server/brand-twin/brand-twin";
import {
  limitNoticeFromError,
  limitNoticeReplyText,
} from "@/server/commands/limit-notice";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { loadBrandRules } from "@/server/works/brand-rule-loader";

import { adsPlanDef, type AdsPlanDraft } from "./plan-prompt";

// Model side of the Ads Manager Plan step (docs/modules.md): one reasoning
// call writes the names and the primary text from the Brief's post, in the
// brand's language and voice. It never writes the card: the action does, so a
// failure leaves the card as it was and the Plan offers the post's own words.

export type AdsPlanScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type DraftAdsPlanResult =
  | { ok: true; plan: AdsPlan }
  | { ok: false; code: "MOCK" | "FAILED" | "BUDGET"; message: string };

export const DRAFT_PLAN_COPY = {
  mock: "AI writing is off here. Write the texts yourself.",
  failed: "Couldn't write the ad. Try again, or write it yourself.",
} as const;

const MAX_PROMPT_RULES = 12;
const MAX_FLAGS = 3;
const NAME_MAX = 60;

function ruleTexts(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = flattenRuleText(value, 120);
    if (text) out.push(text);
    if (out.length >= MAX_PROMPT_RULES) break;
  }
  return out;
}

// Each field cleaned and clipped; one that cleans to nothing keeps the post's
// own words for it.
function planOf(output: AdsPlanDraft, brief: AdsBrief): AdsPlan {
  const fallback = defaultAdsPlan(brief);
  const name = (value: string, other: string) =>
    clipWords(value, NAME_MAX) || other;
  const text = clipWords(
    adTextFrom(output.primaryText),
    ADS_LIMITS.primaryText,
    true,
  );
  return {
    campaignName: name(output.campaignName, fallback.campaignName),
    adSetName: name(output.adSetName, fallback.adSetName),
    adName: name(output.adName, fallback.adName),
    primaryText: text || fallback.primaryText,
  };
}

export async function draftAdsPlan(input: {
  scope: AdsPlanScope;
  brief: AdsBrief;
  language: string;
}): Promise<DraftAdsPlanResult> {
  const { scope, brief, language } = input;

  // A mock answer must never be written into a real card.
  if (ReasoningService.isMockMode()) {
    return { ok: false, code: "MOCK", message: DRAFT_PLAN_COPY.mock };
  }

  const [twin, rules] = await Promise.all([
    getBrandTwin(scope.projectId, { memory: false }).catch(() => null),
    loadBrandRules({
      projectId: scope.projectId,
      brandId: scope.brandId,
      language,
    }),
  ]);

  const objective = ADS_OBJECTIVE_META[brief.objective];
  const facts = {
    language,
    brand: {
      name: cleanWorksTextOrNull(twin?.name, 80),
      personality: cleanWorksTextOrNull(twin?.voice.personality, 160),
      toneOfVoice: cleanWorksTextOrNull(twin?.voice.toneOfVoice, 160),
      positioning: cleanWorksTextOrNull(twin?.positioning, 200),
    },
    objective: { label: objective.label, aim: objective.hint },
    post: {
      // Through flattenRuleText ONLY: the caption is quoted data.
      title: flattenRuleText(brief.source.title, 120),
      caption: flattenRuleText(brief.source.caption ?? "", 600),
    },
    audience: {
      countries: brief.countries.map((code) => countryLabel(code)),
      ages: ageRangeText(brief.ageMin, brief.ageMax),
      gender: ADS_GENDER_LABEL[brief.gender],
    },
    link: linkDomain(brief.link),
    callToAction: ADS_CTA_LABEL[brief.callToAction],
    limits: { primaryText: ADS_LIMITS.primaryText, names: NAME_MAX },
    neverRules: ruleTexts(rules?.never.map((rule) => rule.text) ?? []),
    approvedClaims: ruleTexts(rules?.approvedClaims ?? []),
  };

  try {
    const { output } = await ReasoningService.run(adsPlanDef, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      context: { facts },
    });
    const plan = planOf(output, brief);
    // Shown on the Plan, never blocking: the person edits before launching.
    const flags = [
      ...new Set(
        blocksOf(checkText(plan.primaryText, rules)).map((flag) =>
          flag.matched.slice(0, 80),
        ),
      ),
    ].slice(0, MAX_FLAGS);
    return { ok: true, plan: flags.length > 0 ? { ...plan, flags } : plan };
  } catch (error) {
    const notice = limitNoticeFromError(error);
    if (notice) {
      return {
        ok: false,
        code: "BUDGET",
        message: limitNoticeReplyText(notice),
      };
    }
    console.error(
      "[works] ads plan failed:",
      error instanceof Error ? error.message : error,
    );
    return { ok: false, code: "FAILED", message: DRAFT_PLAN_COPY.failed };
  }
}
