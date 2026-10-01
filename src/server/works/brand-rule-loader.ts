import "server-only";

import { prisma } from "@/lib/prisma";
import { foldForMatch } from "@/lib/text-fold";
import type {
  BrandRule,
  BrandRuleOrigin,
  BrandRuleSet,
} from "@/lib/works/brand-rules";

// Loads the brand rules the pure checker needs (spec 3.7.4). Fails open: any
// error logs and returns null so a cold database never blocks a plan, and the
// card shows the check as skipped (brandCheckOf).

export const MAX_BRAND_RULES = 60;
const MAX_COMPETITORS = 20;
const MAX_MEMORY_RULES = 20;

export type BrandRuleLoadInput = {
  projectId: string;
  brandId: string;
  language: string;
};

function originOfCategory(category: string | null): BrandRuleOrigin {
  if (category === "forbidden-claim") return "forbidden-claim";
  if (category === "client-rule") return "client-rule";
  return "negative-brief";
}

export async function loadBrandRules(
  input: BrandRuleLoadInput,
): Promise<BrandRuleSet | null> {
  const { projectId, brandId, language } = input;
  try {
    const [negatives, claims, competitors, learnings] = await Promise.all([
      prisma.negativeBriefRule.findMany({
        where: { projectId, brandId, active: true },
        select: { rule: true, category: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.approvedClaim.findMany({
        where: { projectId, brandId, active: true },
        select: { claim: true },
      }),
      prisma.competitor.findMany({
        where: { projectId },
        select: { name: true },
        take: MAX_COMPETITORS,
      }),
      prisma.brandLearning.findMany({
        where: {
          projectId,
          brandId,
          polarity: "AVOID",
          sourceType: "USER_EXPLICIT",
        },
        select: { insight: true },
        orderBy: { createdAt: "desc" },
        take: MAX_MEMORY_RULES,
      }),
    ]);

    const candidates: BrandRule[] = [
      ...negatives.map((row) => ({
        text: row.rule,
        origin: originOfCategory(row.category),
      })),
      ...learnings.map((row) => ({ text: row.insight, origin: "memory" as const })),
    ];
    const seen = new Set<string>();
    const never: BrandRule[] = [];
    for (const rule of candidates) {
      const text = rule.text.trim();
      const key = foldForMatch(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      never.push({ text, origin: rule.origin });
      if (never.length >= MAX_BRAND_RULES) break;
    }

    return {
      language,
      never,
      approvedClaims: claims.map((row) => row.claim.trim()).filter(Boolean),
      competitors: competitors.map((row) => row.name.trim()).filter(Boolean),
    };
  } catch (error) {
    console.error("[works] brand rule load failed", error);
    return null;
  }
}

// One load per turn: the promise is memoised so several tools share it.
export function createBrandRulesGetter(
  input: BrandRuleLoadInput,
): () => Promise<BrandRuleSet | null> {
  let pending: Promise<BrandRuleSet | null> | null = null;
  return () => {
    pending ??= loadBrandRules(input);
    return pending;
  };
}
