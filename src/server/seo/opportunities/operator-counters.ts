import "server-only";

import { prisma } from "@/lib/prisma";
import { SeoInsightFlags, type SeoInsightsMode } from "@/lib/seo/insight-flags";
import { SEO_RULE_KEYS, type SeoRuleKey } from "@/lib/seo/opportunity-types";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// /health ve /health/search-opportunities operatör sayaçları (SC-F4,
// docs/search-opportunities.md): yalnız sayılar ve kural anahtarı; başlık,
// özet, kanıt ya da anahtar kelime hiç seçilmez. SEO_INSIGHTS=off iken
// veritabanına gidilmez. Her sayaç kendi hatasında 0 olur. Yalnız geçerli
// kipin (gerçek/mock) bağları sayılır.

export type SeoOpportunityCounters = {
  mode: SeoInsightsMode;
  linksTracked: number;
  ran24h: number;
  failing: number;
  findings14d: number;
  byRule: {
    ruleKey: SeoRuleKey;
    created14d: number;
    useful: number;
    notUseful: number;
  }[];
  reviewed: number;
  precision: number | null;
  llmSkippedBudget: number;
};

const DAY_MS = 24 * 3_600_000;
const CREATED_WINDOW_DAYS = 14;
const REVIEW_WINDOW_DAYS = 30;

type RuleCount = { ruleKey: string; _count: { _all: number } };
type ReviewCount = RuleCount & { review: string | null };

export async function loadSeoOpportunityCounters(
  now: Date = new Date(),
): Promise<SeoOpportunityCounters | null> {
  const mode = SeoInsightFlags.mode();
  if (mode === "off") return null;
  const isMock = gscMockMode();
  const since14d = new Date(now.getTime() - CREATED_WINDOW_DAYS * DAY_MS);
  const since30d = new Date(now.getTime() - REVIEW_WINDOW_DAYS * DAY_MS);
  const [linksTracked, ran24h, failing, llmSkippedBudget, created, reviews] =
    await Promise.all([
      prisma.seoEngineState.count({ where: { isMock } }).catch(() => 0),
      prisma.seoEngineState
        .count({
          where: {
            isMock,
            lastRunAt: { gte: new Date(now.getTime() - DAY_MS) },
          },
        })
        .catch(() => 0),
      prisma.seoEngineState
        .count({ where: { isMock, consecutiveFailures: { gt: 0 } } })
        .catch(() => 0),
      // Son koşuda LLM adımları bütçe yüzünden atlandı mı (Json yol süzgeci).
      prisma.seoEngineState
        .count({
          where: {
            isMock,
            lastRunStats: { path: ["llmSkipped"], equals: "budget" },
          },
        })
        .catch(() => 0),
      // createdAt indeksi; yalnız kural anahtarına göre sayı.
      prisma.seoFinding
        .groupBy({
          by: ["ruleKey"],
          where: { createdAt: { gte: since14d }, link: { isMock } },
          _count: { _all: true },
        })
        .then((rows): RuleCount[] => rows)
        .catch((): RuleCount[] => []),
      prisma.seoFinding
        .groupBy({
          by: ["ruleKey", "review"],
          where: {
            reviewedAt: { gte: since30d },
            review: { in: ["USEFUL", "NOT_USEFUL"] },
            link: { isMock },
          },
          _count: { _all: true },
        })
        .then((rows): ReviewCount[] => rows)
        .catch((): ReviewCount[] => []),
    ]);

  const byRule = SEO_RULE_KEYS.map((ruleKey) => {
    const createdRow = created.find((row) => row.ruleKey === ruleKey);
    const reviewed = (verdict: string) =>
      reviews.find((row) => row.ruleKey === ruleKey && row.review === verdict)
        ?._count._all ?? 0;
    return {
      ruleKey,
      created14d: createdRow?._count._all ?? 0,
      useful: reviewed("USEFUL"),
      notUseful: reviewed("NOT_USEFUL"),
    };
  });
  const findings14d = byRule.reduce((sum, row) => sum + row.created14d, 0);
  const useful = byRule.reduce((sum, row) => sum + row.useful, 0);
  const notUseful = byRule.reduce((sum, row) => sum + row.notUseful, 0);
  const reviewed = useful + notUseful;
  return {
    mode,
    linksTracked,
    ran24h,
    failing,
    findings14d,
    byRule,
    reviewed,
    precision: reviewed >= 1 ? useful / reviewed : null,
    llmSkippedBudget,
  };
}
