import "server-only";

import type { AdsAccount, AdsLevel, AdsObject } from "@prisma/client";

import { rangeForPreset } from "@/lib/ads/date-range";
import { toMajorUnits } from "@/lib/ads/money";
import { resultLabel } from "@/lib/ads/results";
import { safeTimezone } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import type {
  MetaCampaignSummary,
  MetaInsightsRow,
} from "@/server/integrations/meta-client";

// Aynadan okumalar (docs/meta-ads-plan.md §3.2 "Okuyucuların aynaya geçişi").
// META_ADS_SYNC açıkken Ads sayfası, Works kartı, Analytics ve sohbet
// buradan okur; Meta'ya çağrı yapılmaz. Tutarlar MetaInsightsRow ile aynı
// biçimdedir (harcama ana birimde) ki çağıranlar değişmesin.

export type MirrorFreshness = {
  lastInsightsAt: Date | null;
  lastStructureAt: Date | null;
  timezoneName: string | null;
  healthStatus: string;
  healthReason: string | null;
  currency: string | null;
};

type DayRow = {
  externalId: string;
  date: Date;
  spendMinor: bigint;
  impressions: number;
  reach: number;
  clicks: number;
  results: number | null;
  resultActionType: string | null;
};

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

// Günlük satırların toplamı → MetaInsightsRow. Erişim yalnız tek günlük
// aralıkta kesindir; çok günlük aralıkta pencere değeri verilmişse o
// kullanılır, yoksa bilinmez.
export function insightsFromDays(
  rows: DayRow[],
  currency: string | null,
  options: { singleDay: boolean; windowReach?: number } = { singleDay: false },
): MetaInsightsRow {
  let spendMinor = 0;
  let impressions = 0;
  let clicks = 0;
  let reach = 0;
  let results: number | null = null;
  let resultType: string | null = null;
  for (const row of rows) {
    spendMinor += Number(row.spendMinor);
    impressions += row.impressions;
    clicks += row.clicks;
    reach += row.reach;
    if (row.results !== null) results = (results ?? 0) + row.results;
    resultType = resultType ?? row.resultActionType;
  }
  const spend = toMajorUnits(spendMinor, currency);
  const exactReach = options.singleDay ? reach : options.windowReach;
  return {
    spend,
    impressions,
    ...(exactReach !== undefined ? { reach: exactReach } : {}),
    clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    frequency:
      exactReach && exactReach > 0 ? impressions / exactReach : 0,
    ...(results !== null
      ? {
          resultCount: results,
          resultLabel: resultLabel(resultType),
          ...(results > 0 ? { costPerResult: spend / results } : {}),
        }
      : {}),
  };
}

export const AdsMirror = {
  // Projenin seçili hesabının ayna satırı.
  async accountFor(projectId: string): Promise<AdsAccount | null> {
    const link = await prisma.adsAccountProject.findFirst({
      where: { projectId, selected: true },
      include: { adsAccount: true },
    });
    return link?.adsAccount ?? null;
  },

  async freshness(projectId: string): Promise<MirrorFreshness | null> {
    const account = await this.accountFor(projectId);
    if (!account) return null;
    return {
      lastInsightsAt: account.lastInsightsAt,
      lastStructureAt: account.lastStructureAt,
      timezoneName: account.timezoneName,
      healthStatus: account.healthStatus,
      healthReason: account.healthReason,
      currency: account.currency,
    };
  },

  today(account: Pick<AdsAccount, "timezoneName">, now: Date = new Date()): string {
    return dayKeyInTimezone(now, safeTimezone(account.timezoneName));
  },

  // Bir düzeyin nesne başına insights'ı (ön ayar, hesap gününe göre).
  async insightsByObject(
    account: AdsAccount,
    level: AdsLevel,
    preset: string,
    options: { externalIds?: string[]; now?: Date } = {},
  ): Promise<Map<string, MetaInsightsRow>> {
    const today = this.today(account, options.now);
    const range = rangeForPreset(preset, today);
    const rows = await prisma.adsInsightDaily.findMany({
      where: {
        adsAccountId: account.id,
        level,
        ...(range
          ? { date: { gte: dateOf(range.since), lte: dateOf(range.until) } }
          : {}),
        ...(options.externalIds ? { externalId: { in: options.externalIds } } : {}),
      },
      select: {
        externalId: true,
        date: true,
        spendMinor: true,
        impressions: true,
        reach: true,
        clicks: true,
        results: true,
        resultActionType: true,
      },
    });
    const byId = new Map<string, DayRow[]>();
    for (const row of rows) {
      const list = byId.get(row.externalId) ?? [];
      list.push(row);
      byId.set(row.externalId, list);
    }
    const windows =
      preset === "last_7d" && (level === "ADSET" || level === "AD")
        ? await prisma.adsObject.findMany({
            where: { adsAccountId: account.id, externalId: { in: [...byId.keys()] } },
            select: { externalId: true, windowStats: true },
          })
        : [];
    const windowReach = new Map(
      windows.map((row) => [
        row.externalId,
        (row.windowStats as { d7?: { reach?: number } } | null)?.d7?.reach,
      ]),
    );
    const singleDay = range !== null && range.since === range.until;
    const out = new Map<string, MetaInsightsRow>();
    for (const [externalId, list] of byId) {
      out.set(
        externalId,
        insightsFromDays(list, account.currency, {
          singleDay,
          windowReach: windowReach.get(externalId),
        }),
      );
    }
    return out;
  },

  async objects(
    account: AdsAccount,
    level: AdsLevel,
    where: { parentExternalId?: string } = {},
  ): Promise<AdsObject[]> {
    return prisma.adsObject.findMany({
      where: {
        adsAccountId: account.id,
        level,
        // Arşivlenen / silinen nesneler listede yok (Meta'nın kendi
        // listesi gibi); harcamaları üst düzey toplamlarda kalır.
        goneAt: null,
        ...(where.parentExternalId ? { parentExternalId: where.parentExternalId } : {}),
      },
      orderBy: [{ createdAt: "desc" }],
    });
  },

  // Ads sayfasının kampanya listesi.
  async campaigns(
    account: AdsAccount,
    preset: string,
  ): Promise<(MetaCampaignSummary & { insights?: MetaInsightsRow })[]> {
    const [objects, insights] = await Promise.all([
      this.objects(account, "CAMPAIGN"),
      this.insightsByObject(account, "CAMPAIGN", preset),
    ]);
    return objects.map((object) => ({
      campaignId: object.externalId,
      name: object.name,
      objective: object.objective ?? "",
      status: object.configuredStatus ?? "",
      effectiveStatus: object.effectiveStatus ?? "",
      ...(object.dailyBudgetMinor !== null
        ? { dailyBudgetCents: Number(object.dailyBudgetMinor) }
        : {}),
      ...(object.lifetimeBudgetMinor !== null
        ? { lifetimeBudgetCents: Number(object.lifetimeBudgetMinor) }
        : {}),
      endTime: object.endTime ? object.endTime.toISOString() : null,
      createdByAgentelse: object.createdByAgentelse,
      insights: insights.get(object.externalId),
    }));
  },
};
