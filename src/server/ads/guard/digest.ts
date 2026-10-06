import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import {
  digestCommandId,
  digestText,
  digestWorthy,
  DIGEST_LOCAL_TIME,
} from "@/lib/ads/digest";
import { addDays, safeTimezone } from "@/lib/ads/sync-plan";
import { timeAgo } from "@/lib/dates";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone, utcToZonedDateTimeLocal } from "@/lib/timezone";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { postToAdsChat } from "@/server/ads/ads-chat";
import { claimPeriodic } from "@/server/observability/periodic";

// Günlük Ads özeti (docs/meta-ads-plan.md §3.6, K24): her sabah 08:30'da
// (proje saati) projenin Ads sohbetine SYSTEM mesajı olarak düşer ve
// Recents'te öne çıkar. Ads sohbeti module "ads" olan en yeni Work'tür; yoksa
// ads_<projectId> açılır. Gün başına tek özet: komut kimliği sabittir.

const RUN_EVERY_MS = 10 * 60_000;
const SPEND_CAPABILITIES = [
  "META_CAMPAIGN_CREATE",
  "META_CAMPAIGN_UPDATE",
  "META_ADSET_CREATE",
  "META_ADSET_UPDATE",
  "META_AD_CREATE",
  "META_AD_UPDATE",
  "META_SAFETY_ACTION",
] as const;

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export const AdsDigest = {
  async runDue(limit = 10, now: Date = new Date()): Promise<number> {
    if (!AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.digest", RUN_EVERY_MS, now))) return 0;

    const links = await prisma.adsAccountProject.findMany({
      where: { selected: true, adsAccount: { lastStructureAt: { not: null } } },
      include: { adsAccount: true },
      take: 500,
    });
    let written = 0;
    for (const link of links) {
      if (written >= limit) break;
      const timezone = (await getProjectTimezone(link.projectId).catch(() => null)) ?? "UTC";
      const local = utcToZonedDateTimeLocal(now, safeTimezone(timezone));
      if (local.slice(11) < DIGEST_LOCAL_TIME) continue;
      const day = local.slice(0, 10);
      const commandId = digestCommandId(link.projectId, day);
      const exists = await prisma.command.findUnique({
        where: { id: commandId },
        select: { id: true },
      });
      if (exists) continue;
      if (await this.writeFor(link.projectId, link.brandId, link.adsAccount, day, now)) {
        written += 1;
      }
    }
    return written;
  },

  async writeFor(
    projectId: string,
    brandId: string,
    account: {
      id: string;
      currency: string | null;
      timezoneName: string | null;
      lastInsightsAt: Date | null;
    },
    day: string,
    now: Date,
  ): Promise<boolean> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) return false;
    const accountToday = dayKeyInTimezone(now, safeTimezone(account.timezoneName));
    const yesterday = addDays(accountToday, -1);
    const [spend, running, alerts, pending] = await Promise.all([
      prisma.adsInsightDaily.aggregate({
        where: { adsAccountId: account.id, level: "ACCOUNT", date: dateOf(yesterday) },
        _sum: { spendMinor: true },
      }),
      prisma.adsObject.findMany({
        where: {
          adsAccountId: account.id,
          level: { in: ["CAMPAIGN", "ADSET"] },
          configuredStatus: "ACTIVE",
          goneAt: null,
          OR: [{ endTime: null }, { endTime: { gt: now } }],
        },
        select: { level: true, dailyBudgetMinor: true, campaignExternalId: true },
      }),
      AdsAlerts.listOpen(projectId, 10),
      prisma.task.count({
        where: {
          projectId,
          status: "WAITING_APPROVAL",
          capability: { in: [...SPEND_CAPABILITIES] },
        },
      }),
    ]);
    const campaigns = running.filter((row) => row.level === "CAMPAIGN");
    // CBO'da kampanya, ABO'da ad set bütçesi.
    const planned = running.reduce((sum, row) => {
      if (row.dailyBudgetMinor === null) return sum;
      if (row.level === "ADSET") {
        const parent = campaigns.find(
          (campaign) => campaign.campaignExternalId === row.campaignExternalId,
        );
        if (parent?.dailyBudgetMinor) return sum;
      }
      return sum + Number(row.dailyBudgetMinor);
    }, 0);
    const facts = {
      currency: account.currency,
      yesterdaySpendMinor: Number(spend._sum.spendMinor ?? 0),
      plannedDailyMinor: planned,
      runningCampaigns: campaigns.length,
      criticalAlerts: alerts.filter((a) => a.severity === "CRITICAL").map((a) => a.title),
      warnAlerts: alerts.filter((a) => a.severity === "WARN").map((a) => a.title),
      pendingDecisions: pending,
      updatedText: account.lastInsightsAt
        ? `Numbers updated ${timeAgo(account.lastInsightsAt)}.`
        : null,
    };
    if (!digestWorthy(facts)) return false;

    return postToAdsChat({
      projectId,
      brandId,
      commandId: digestCommandId(projectId, day),
      text: `Ads today\n${digestText(facts)}`,
      summary: "Daily ads check",
      now,
    });
  },
};
