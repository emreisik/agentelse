import "server-only";

import { prisma } from "@/lib/prisma";
import { SeoActionFlags } from "@/lib/seo/action-flags";
import { OPEN_ACTION_STATUSES } from "@/lib/seo/actions/kinds";
import type { EvaluationReason } from "@/lib/seo/actions/types";
import { seoMockMode } from "@/lib/seo/health-flags";

// /health "SEO actions" operatör sayaçları (docs/search-actions.md): yalnız
// sayılar. Hedef URL, sorgu, kanıt ya da kullanıcı metni hiç seçilmez.
// Bayrak kapalıyken veritabanına gidilmez; her sayaç kendi hatasında 0 olur.
// Yalnız geçerli kipin (gerçek/mock) satırları sayılır. 30 günlük
// INCONCLUSIVE dökümü nedenlere göre verilir: planın "eylemlerin ≥ %80'i bir
// sonuca varsın" hedefi buradan denetlenir.

export type SeoActionCounters = {
  open: number;
  awaitingVerification: number;
  asked: number;
  measuring: number;
  evaluated30d: { worked: number; didnt: number; inconclusive: number };
  inconclusiveByReason30d: Partial<Record<EvaluationReason, number>>;
  expired30d: number;
  learnings30d: number;
};

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

const REASONS: readonly EvaluationReason[] = [
  "LOW_DATA",
  "NO_DATA",
  "NO_SEARCH_DATA",
  "NO_PAGE",
  "GOOGLE_UPDATE",
  "OVERLAPPING_CHANGE",
  "ALERT_GONE",
];

function isReason(value: string): value is EvaluationReason {
  return (REASONS as readonly string[]).includes(value);
}

export async function loadSeoActionCounters(
  now: Date = new Date(),
): Promise<SeoActionCounters | null> {
  if (!SeoActionFlags.loop()) return null;
  const isMock = seoMockMode();
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const zero = () => 0;
  const [
    open,
    awaitingVerification,
    asked,
    measuring,
    evaluated,
    reasons,
    expired30d,
    learnings30d,
  ] = await Promise.all([
    prisma.seoAction
      .count({ where: { isMock, status: { in: [...OPEN_ACTION_STATUSES] } } })
      .catch(zero),
    prisma.seoAction
      .count({ where: { isMock, status: { in: ["APPLIED", "VERIFIED"] } } })
      .catch(zero),
    prisma.seoAction
      .count({
        where: {
          isMock,
          status: { in: ["APPLIED", "VERIFIED"] },
          askedAt: { not: null },
        },
      })
      .catch(zero),
    prisma.seoAction
      .count({ where: { isMock, status: "EVALUATING" } })
      .catch(zero),
    prisma.seoAction
      .groupBy({
        by: ["status"],
        where: {
          isMock,
          status: { in: ["WORKED", "DIDNT", "INCONCLUSIVE"] },
          evaluatedAt: { gte: since },
        },
        _count: { _all: true },
      })
      .catch(() => [] as { status: string; _count: { _all: number } }[]),
    prisma.$queryRaw<{ reason: string | null; count: number }[]>`
        SELECT "evaluation"->>'reason' AS "reason", COUNT(*)::int AS "count"
          FROM "SeoAction"
         WHERE "isMock" = ${isMock}
           AND "status" = 'INCONCLUSIVE'
           AND "evaluatedAt" >= ${since}
         GROUP BY 1
      `.catch(() => [] as { reason: string | null; count: number }[]),
    prisma.seoAction
      .count({
        where: { isMock, status: "EXPIRED", updatedAt: { gte: since } },
      })
      .catch(zero),
    prisma.seoAction
      .count({
        where: {
          isMock,
          learningId: { not: null },
          evaluatedAt: { gte: since },
        },
      })
      .catch(zero),
  ]);

  const evaluatedCount = (status: string) =>
    evaluated.find((row) => row.status === status)?._count._all ?? 0;
  const inconclusiveByReason30d: Partial<Record<EvaluationReason, number>> = {};
  for (const row of reasons) {
    if (row.reason && isReason(row.reason)) {
      inconclusiveByReason30d[row.reason] = Number(row.count);
    }
  }
  return {
    open,
    awaitingVerification,
    asked,
    measuring,
    evaluated30d: {
      worked: evaluatedCount("WORKED"),
      didnt: evaluatedCount("DIDNT"),
      inconclusive: evaluatedCount("INCONCLUSIVE"),
    },
    inconclusiveByReason30d,
    expired30d,
    learnings30d,
  };
}
