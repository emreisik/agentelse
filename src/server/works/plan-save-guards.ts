import "server-only";

import { prisma } from "@/lib/prisma";
import { blocksOf, checkItems } from "@/lib/works/brand-rules";
import { copyText } from "@/lib/works/copy";
import { brandRuleLanguageOf } from "@/server/brand/rule-language";
import { todayInTimezone, validatePlanDates } from "@/server/chat/content-plan";
import { assertWorkActive } from "@/server/works/guard";
import { loadBrandRules } from "@/server/works/brand-rule-loader";

// The three checks "Save plan" runs before it writes anything, pulled out of
// saveContentPlanAction (the only caller until now) so an unattended SYSTEM
// save (weekly-plan-produce.ts) can run the exact same guards instead of a
// second, drifting copy of them.
//
// A session caller (saveContentPlanAction) and a SYSTEM caller differ on one
// thing: what an unreadable rule set means. The session path has always let
// the save through when loadBrandRules returns null (checkItems sees no
// rules, nothing to flag) — that stays, unchanged, for the owner's own click.
// A SYSTEM save has no one to show a "couldn't check brand rules" warning to,
// so it fails CLOSED instead: `failClosedOnRulesUnavailable: true` treats
// "couldn't check" the same as "blocked".

export type PlanSaveGuardOutcome =
  | { ok: true; matchedTerms: string[] }
  | {
      ok: false;
      code: "WORK_INACTIVE" | "STALE" | "BRAND_RULES" | "RULES_UNAVAILABLE";
      message: string;
    };

export async function assertPlanSaveable(params: {
  projectId: string;
  brandId: string;
  workId: string;
  card: {
    timezone: string;
    items: readonly { date: string; topic?: string; captionIdea?: string }[];
  };
  allowIssues?: boolean;
  failClosedOnRulesUnavailable?: boolean;
}): Promise<PlanSaveGuardOutcome> {
  const active = await assertWorkActive(prisma, {
    workId: params.workId,
    projectId: params.projectId,
  });
  if (!active.ok) {
    return { ok: false, code: "WORK_INACTIVE", message: active.message };
  }

  if (
    validatePlanDates(params.card.items, todayInTimezone(params.card.timezone))
  ) {
    return { ok: false, code: "STALE", message: copyText("plan.stale") };
  }

  const rules = await loadBrandRules({
    projectId: params.projectId,
    brandId: params.brandId,
    language: await brandRuleLanguageOf(params.projectId),
  });
  if (rules === null && params.failClosedOnRulesUnavailable) {
    return {
      ok: false,
      code: "RULES_UNAVAILABLE",
      message: "Brand rules couldn't be checked.",
    };
  }

  const blocks = blocksOf(checkItems(params.card.items, rules));
  if (blocks.length > 0) {
    if (!params.allowIssues) {
      return {
        ok: false,
        code: "BRAND_RULES",
        message: copyText("brand.blockedSave"),
      };
    }
    return {
      ok: true,
      matchedTerms: blocks.map((block) => block.flag.matched.slice(0, 40)),
    };
  }
  return { ok: true, matchedTerms: [] };
}
