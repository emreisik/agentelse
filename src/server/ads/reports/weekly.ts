import "server-only";

import type { AdsAccount } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import { toMinorUnits } from "@/lib/ads/money";
import { diagnose } from "@/lib/ads/reports/diagnose";
import {
  adLibraryUrl,
  monthlyReportText,
  weeklyReportText,
  type ReportTotals,
} from "@/lib/ads/reports/report-text";
import { resultLabel } from "@/lib/ads/results";
import { windowOf, type DayRow } from "@/lib/ads/rules/features";
import { addDays, safeTimezone } from "@/lib/ads/sync-plan";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";
import { commandExists, postToAdsChat } from "@/server/ads/ads-chat";
import { AdsAccounts } from "@/server/ads/accounts";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import {
  readPeriodReach,
  readRecommendations,
} from "@/server/integrations/meta/sync-reads";
import { claimPeriodic } from "@/server/observability/periodic";

import { AdsLearnings } from "./learnings";
import { AdsLineageLearnings } from "./lineage-learnings";

// Haftalık ve aylık Ads raporları (docs/meta-ads-plan.md §3.7, F6,
// `META_ADS_REPORTS`). Raporlar AdsInsightDaily'nin görünümleridir; ayrı tablo
// tutulmaz. Haftalık: Pazartesi 08:00 (proje saati), geçen Pazartesi-Pazar
// (hesap günü). Aylık: ayın 1'i 09:00, geçen ay. Dönem erişimi tek bir Meta
// okumasıyla gelir; Meta önerileri ikinci görüş olarak eklenir.

const RUN_EVERY_MS = 10 * 60_000;

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

// Bugünün ISO haftasının Pazartesi'si.
function mondayOf(day: string): string {
  const shift = (weekday(day) + 6) % 7;
  return addDays(day, -shift);
}

function dayRows(
  rows: {
    date: Date;
    spendMinor: bigint;
    impressions: number;
    clicks: number;
    linkClicks: number;
    results: number | null;
    video3s: number | null;
    thruplays: number | null;
  }[],
): DayRow[] {
  return rows.map((row) => ({
    date: row.date.toISOString().slice(0, 10),
    spendMinor: Number(row.spendMinor),
    impressions: row.impressions,
    clicks: row.clicks,
    linkClicks: row.linkClicks,
    results: row.results,
    video3s: row.video3s,
    thruplays: row.thruplays,
  }));
}

async function periodReach(
  account: AdsAccount,
  projectId: string,
  since: string,
  until: string,
): Promise<{ reach: number; frequency: number } | null> {
  const resolved = await AdsAccounts.resolveWithToken(projectId).catch(
    () => null,
  );
  if (!resolved || !("accessToken" in resolved)) return null;
  return withMetaCallContext(
    {
      account: account.externalId,
      lane: "P2_BACKGROUND",
      callSite: "ads.report",
    },
    () =>
      readPeriodReach({
        adAccountId: account.externalId,
        accessToken: resolved.accessToken,
        since,
        until,
      }),
  ).catch(() => null);
}

async function metaSuggests(
  account: AdsAccount,
  projectId: string,
): Promise<string[]> {
  const resolved = await AdsAccounts.resolveWithToken(projectId).catch(
    () => null,
  );
  if (!resolved || !("accessToken" in resolved)) return [];
  return withMetaCallContext(
    {
      account: account.externalId,
      lane: "P2_BACKGROUND",
      callSite: "ads.recommendations",
    },
    () => readRecommendations(account.externalId, resolved.accessToken),
  ).catch(() => []);
}

async function totalsFor(
  account: AdsAccount,
  since: string,
  until: string,
): Promise<{ totals: ReportTotals; attribution: string | null }> {
  const rows = await prisma.adsInsightDaily.findMany({
    where: {
      adsAccountId: account.id,
      level: "ACCOUNT",
      date: { gte: dateOf(since), lte: dateOf(until) },
    },
  });
  const window = windowOf(dayRows(rows), since, until);
  const type =
    rows.find((row) => row.resultActionType)?.resultActionType ?? null;
  const attribution =
    rows.find((row) => row.attributionSetting)?.attributionSetting ?? null;
  return {
    totals: {
      spendMinor: window.spendMinor,
      results: window.results,
      resultLabel: resultLabel(type),
      impressions: window.impressions,
      linkClicks: window.linkClicks,
      reach: null,
      frequency: null,
    },
    attribution,
  };
}

async function targetOf(projectId: string, currency: string | null) {
  const goal = await prisma.projectGoal.findFirst({
    where: { projectId, status: "ACTIVE", metricKey: { startsWith: "ads." } },
    orderBy: { updatedAt: "desc" },
    select: { metricKey: true, targetValue: true },
  });
  if (!goal?.targetValue) return null;
  const label =
    goal.metricKey === "ads.cpl"
      ? "cost per lead"
      : goal.metricKey === "ads.cost_per_conversation"
        ? "cost per conversation"
        : goal.metricKey === "ads.cost_per_click"
          ? "cost per visit"
          : "cost per result";
  return { label, valueMinor: toMinorUnits(goal.targetValue, currency) };
}

export const AdsReports = {
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (!AdsFlags.reports() || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.reports", RUN_EVERY_MS, now))) return 0;
    // Öğrenmeler raporlardan bağımsız: değerlendirilmiş kararlardan.
    await AdsLearnings.writeDue(now).catch(() => 0);
    // Nitelik düzeyinde öğrenme: hangi kanca / teklif / biçim daha ucuza getiriyor.
    await AdsLineageLearnings.writeDue(now).catch(() => 0);

    const links = await prisma.adsAccountProject.findMany({
      where: { selected: true, adsAccount: { lastStructureAt: { not: null } } },
      include: { adsAccount: true },
      take: 500,
    });
    let written = 0;
    for (const link of links) {
      if (written >= limit) break;
      const tz = safeTimezone(
        (await getProjectTimezone(link.projectId).catch(() => null)) ?? "UTC",
      );
      const local = utcToZonedDateTimeLocal(now, tz);
      const localDay = local.slice(0, 10);
      const time = local.slice(11);
      if (weekday(localDay) === 1 && time >= "08:00") {
        if (
          await this.writeWeekly(
            link.projectId,
            link.brandId,
            link.adsAccount,
            now,
          )
        )
          written += 1;
      }
      if (localDay.endsWith("-01") && time >= "09:00") {
        if (
          await this.writeMonthly(
            link.projectId,
            link.brandId,
            link.adsAccount,
            now,
          )
        )
          written += 1;
      }
    }
    return written;
  },

  async writeWeekly(
    projectId: string,
    brandId: string,
    account: AdsAccount,
    now: Date,
  ): Promise<boolean> {
    const today = dayKeyInTimezone(now, safeTimezone(account.timezoneName));
    const monday = mondayOf(today);
    const commandId = `adsweekly_${projectId}_${monday}`;
    if (await commandExists(commandId)) return false;
    const since = addDays(monday, -7);
    const until = addDays(monday, -1);
    const [{ totals: current, attribution }, { totals: previous }] =
      await Promise.all([
        totalsFor(account, since, until),
        totalsFor(account, addDays(monday, -14), addDays(monday, -8)),
      ]);
    if (current.spendMinor === 0 && previous.spendMinor === 0) return false;

    const reach = await periodReach(account, projectId, since, until);
    if (reach) {
      current.reach = reach.reach;
      current.frequency = reach.frequency;
    }
    const adRows = await prisma.adsInsightDaily.findMany({
      where: {
        adsAccountId: account.id,
        level: "AD",
        date: { gte: dateOf(since), lte: dateOf(until) },
      },
      select: { externalId: true, spendMinor: true, results: true },
    });
    const byAd = new Map<
      string,
      { spendMinor: number; results: number | null }
    >();
    for (const row of adRows) {
      const entry = byAd.get(row.externalId) ?? {
        spendMinor: 0,
        results: null,
      };
      entry.spendMinor += Number(row.spendMinor);
      if (row.results !== null)
        entry.results = (entry.results ?? 0) + row.results;
      byAd.set(row.externalId, entry);
    }
    const top = [...byAd.entries()]
      .sort(
        (a, b) =>
          (b[1].results ?? 0) - (a[1].results ?? 0) ||
          b[1].spendMinor - a[1].spendMinor,
      )
      .slice(0, 3);
    const names = await prisma.adsObject.findMany({
      where: {
        adsAccountId: account.id,
        externalId: { in: top.map(([id]) => id) },
      },
      select: { externalId: true, name: true },
    });
    const nameOf = new Map(names.map((row) => [row.externalId, row.name]));
    const decisions = await prisma.adsDecision.findMany({
      where: {
        projectId,
        OR: [
          { appliedAt: { gte: dateOf(since), lt: dateOf(monday) } },
          { evaluatedAt: { gte: dateOf(since), lt: dateOf(monday) } },
        ],
      },
      orderBy: { appliedAt: "desc" },
      take: 5,
      select: { explanation: true, outcome: true },
    });
    const pending = await prisma.adsDecision.count({
      where: { projectId, status: "PROPOSED", taskId: { not: null } },
    });
    const text = weeklyReportText({
      periodLabel: `${since} – ${until}`,
      currency: account.currency,
      current,
      previous,
      target: await targetOf(projectId, account.currency),
      diagnosis: diagnose(current, previous)?.text ?? null,
      creatives: top.map(([id, entry]) => ({
        name: nameOf.get(id) ?? id,
        spendMinor: entry.spendMinor,
        results: entry.results,
      })),
      decisions: decisions.map((decision) => ({
        text: decision.explanation.split(". ")[0]!.slice(0, 160),
        outcome: decision.outcome,
      })),
      pending,
      metaSuggests: await metaSuggests(account, projectId),
      attribution,
    });
    const posted = await postToAdsChat({
      projectId,
      brandId,
      commandId,
      text,
      summary: "Weekly ads report",
      now,
    });
    if (posted) {
      // Brand Brain anlatısı için haftada tek özet sinyal.
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { workspaceId: true },
      });
      if (project) {
        await SignalUniverse.ingestRaw({
          workspaceId: project.workspaceId,
          projectId,
          brandId,
          source: "meta-ads-weekly",
          category: "PERFORMANCE",
          externalRef: `meta-ads-week:${account.externalId}:${monday}`,
          title: `Ads week ${since} – ${until}`,
          summary: text.split("\n").slice(1, 3).join(" "),
          reliability: 1,
        }).catch(() => undefined);
      }
    }
    return posted;
  },

  async writeMonthly(
    projectId: string,
    brandId: string,
    account: AdsAccount,
    now: Date,
  ): Promise<boolean> {
    const today = dayKeyInTimezone(now, safeTimezone(account.timezoneName));
    const firstOfThis = `${today.slice(0, 7)}-01`;
    const until = addDays(firstOfThis, -1);
    const since = `${until.slice(0, 7)}-01`;
    const commandId = `adsmonthly_${projectId}_${since.slice(0, 7)}`;
    if (await commandExists(commandId)) return false;
    const { totals } = await totalsFor(account, since, until);
    if (totals.spendMinor === 0) return false;
    const reach = await periodReach(account, projectId, since, until);
    if (reach) {
      totals.reach = reach.reach;
      totals.frequency = reach.frequency;
    }
    const [goals, decisions, learnings, running, project] = await Promise.all([
      prisma.projectGoal.findMany({
        where: {
          projectId,
          status: "ACTIVE",
          metricKey: { startsWith: "ads." },
        },
        select: { title: true, currentValue: true, targetValue: true },
      }),
      prisma.adsDecision.findMany({
        where: {
          projectId,
          evaluatedAt: { gte: dateOf(since), lte: dateOf(addDays(until, 1)) },
        },
        select: { outcome: true },
      }),
      prisma.brandLearning.count({
        where: {
          projectId,
          sourceType: "META_ADS",
          createdAt: { gte: dateOf(since), lt: dateOf(firstOfThis) },
        },
      }),
      prisma.adsObject.findMany({
        where: {
          adsAccountId: account.id,
          level: { in: ["CAMPAIGN", "ADSET"] },
          configuredStatus: "ACTIVE",
          goneAt: null,
        },
        select: {
          level: true,
          dailyBudgetMinor: true,
          campaignExternalId: true,
          externalId: true,
        },
      }),
      prisma.project.findUnique({
        where: { id: projectId },
        select: { country: true },
      }),
    ]);
    const campaignsWithBudget = new Set(
      running
        .filter((row) => row.level === "CAMPAIGN" && row.dailyBudgetMinor)
        .map((row) => row.externalId),
    );
    const dailyTotal = running.reduce((sum, row) => {
      if (!row.dailyBudgetMinor) return sum;
      if (
        row.level === "ADSET" &&
        row.campaignExternalId &&
        campaignsWithBudget.has(row.campaignExternalId)
      ) {
        return sum;
      }
      return sum + Number(row.dailyBudgetMinor);
    }, 0);
    const [y, m] = firstOfThis.split("-").map(Number);
    const daysThisMonth = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const text = monthlyReportText({
      monthLabel: since.slice(0, 7),
      currency: account.currency,
      totals,
      goals: goals.map((goal) => ({
        title: goal.title,
        current: goal.currentValue,
        target: goal.targetValue,
      })),
      decisionsWorked: decisions.filter((row) => row.outcome === "WORKED")
        .length,
      decisionsTotal: decisions.length,
      learnings,
      nextEnvelopeMinor: dailyTotal > 0 ? dailyTotal * daysThisMonth : null,
      adLibraryUrl: adLibraryUrl(project?.country ?? null),
    });
    return postToAdsChat({
      projectId,
      brandId,
      commandId,
      text,
      summary: "Monthly ads report",
      now,
    });
  },
};
