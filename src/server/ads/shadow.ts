import "server-only";

import { windowOf, type DayRow } from "@/lib/ads/rules/features";
import {
  humanAgreed,
  scorecardOf,
  shadowVerdict,
  type ShadowRow,
  type ShadowScorecard,
  type ShadowVerdict,
} from "@/lib/ads/rules/shadow-score";
import { addDays, safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";

// Gölge modun ölçümü (docs/meta-ads-autonomy.md). Optimizer SHADOW'da kararını
// yazar ama uygulamaz; kararın üzerinden bir hafta geçince burada ölçülür:
// sinyal sürdü mü, sen aynısını yaptın mı? Sonuç, kararın kendi satırına yazılır
// (outcome SHADOW_*), evaluatedAt boş kalır: uygulanan kararların "işe yaradı"
// sayımlarını (aylık rapor, öğrenmeler) karıştırmaz.

const DAY_MS = 24 * 60 * 60_000;
// Karardan sonra 7 tam gün + veri olgunluğu için 1 gün.
const WAIT_DAYS = 8;
const OUTCOME_PREFIX = "SHADOW_";

type ShadowData = {
  shadow: true;
  verdict: ShadowVerdict;
  ratio: number | null;
  exposureMinor: number;
  humanAgreed: boolean | null;
};

function isShadowData(value: unknown): value is ShadowData {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { shadow?: unknown }).shadow === true
  );
}

export const AdsShadow = {
  async evaluateDue(limit = 20, now: Date = new Date()): Promise<number> {
    const due = await prisma.adsDecision.findMany({
      where: {
        status: "SHADOW",
        outcome: null,
        createdAt: { lt: new Date(now.getTime() - WAIT_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let evaluated = 0;
    for (const decision of due) {
      const account = await prisma.adsAccount.findUnique({
        where: { id: decision.adsAccountId },
        select: { timezoneName: true },
      });
      const day = dayKeyInTimezone(
        decision.createdAt,
        safeTimezone(account?.timezoneName),
      );
      const rows = await prisma.adsInsightDaily.findMany({
        where: {
          adsAccountId: decision.adsAccountId,
          externalId: decision.externalId,
          level: decision.level,
          date: {
            gte: new Date(`${addDays(day, -7)}T00:00:00Z`),
            lte: new Date(`${addDays(day, 7)}T00:00:00Z`),
          },
        },
      });
      const days: DayRow[] = rows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        spendMinor: Number(row.spendMinor),
        impressions: row.impressions,
        clicks: row.clicks,
        linkClicks: row.linkClicks,
        results: row.results,
        video3s: row.video3s,
        thruplays: row.thruplays,
      }));
      const before = windowOf(days, addDays(day, -7), addDays(day, -1));
      const after = windowOf(days, addDays(day, 1), addDays(day, 7));
      const verdict = shadowVerdict(
        decision.kind,
        { spendMinor: before.spendMinor, results: before.results ?? 0 },
        { spendMinor: after.spendMinor, results: after.results ?? 0 },
      );
      const object = await prisma.adsObject.findUnique({
        where: {
          adsAccountId_externalId: {
            adsAccountId: decision.adsAccountId,
            externalId: decision.externalId,
          },
        },
        select: { configuredStatus: true, dailyBudgetMinor: true, goneAt: true },
      });
      const agreed = object
        ? humanAgreed(
            decision.kind,
            (decision.change ?? null) as {
              field?: unknown;
              from?: unknown;
              to?: unknown;
            } | null,
            {
              configuredStatus: object.configuredStatus,
              dailyBudgetMinor:
                object.dailyBudgetMinor === null
                  ? null
                  : Number(object.dailyBudgetMinor),
              gone: object.goneAt !== null,
            },
          )
        : null;
      const data: ShadowData = {
        shadow: true,
        verdict: verdict.verdict,
        ratio: verdict.ratio,
        exposureMinor: verdict.exposureMinor,
        humanAgreed: agreed,
      };
      // Yalnız hâlâ işlenmemişse yaz (iki işçi aynı satırı çift saymasın).
      const updated = await prisma.adsDecision.updateMany({
        where: { id: decision.id, status: "SHADOW", outcome: null },
        data: {
          outcome: `${OUTCOME_PREFIX}${verdict.verdict}`,
          outcomeData: data as never,
        },
      });
      evaluated += updated.count;
    }
    return evaluated;
  },

  // Bir projenin gölge karnesi (son `days` gün): karar türüne göre sürme ve
  // insanla uyum, yeterlilik kararı.
  async scorecard(
    projectId: string,
    now: Date = new Date(),
    days = 90,
  ): Promise<ShadowScorecard> {
    const decisions = await prisma.adsDecision.findMany({
      where: {
        projectId,
        status: "SHADOW",
        outcome: { startsWith: OUTCOME_PREFIX },
        createdAt: { gt: new Date(now.getTime() - days * DAY_MS) },
      },
      select: { kind: true, outcomeData: true },
    });
    const rows: ShadowRow[] = [];
    for (const decision of decisions) {
      if (!isShadowData(decision.outcomeData)) continue;
      rows.push({
        kind: decision.kind,
        verdict: decision.outcomeData.verdict,
        exposureMinor: decision.outcomeData.exposureMinor,
        humanAgreed: decision.outcomeData.humanAgreed,
      });
    }
    return scorecardOf(rows);
  },
};
