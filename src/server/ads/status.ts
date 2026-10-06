import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { safeTimezone } from "@/lib/ads/sync-plan";
import { timeAgo } from "@/lib/dates";
import { prisma } from "@/lib/prisma";
import type { AdsAccountStatusProps } from "@/components/ads/ads-account-status";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { getProjectTimezone } from "@/server/chat/content-plan";

// Ads account başlığının verisi (aynadan; Meta'ya çağrı yok).
export async function loadAdsAccountStatus(
  projectId: string,
  now: Date = new Date(),
): Promise<Omit<AdsAccountStatusProps, "projectId"> | null> {
  const account = await AdsMirror.accountFor(projectId);
  if (!account) return null;
  const [alerts, running, projectTimezone] = await Promise.all([
    AdsAlerts.listOpen(projectId, 8),
    prisma.adsObject.count({
      where: {
        adsAccountId: account.id,
        level: "CAMPAIGN",
        configuredStatus: "ACTIVE",
        goneAt: null,
        OR: [{ endTime: null }, { endTime: { gt: now } }],
      },
    }),
    getProjectTimezone(projectId).catch(() => null),
  ]);
  const accountTimezone = safeTimezone(account.timezoneName);
  return {
    healthStatus: account.healthStatus,
    healthReason: account.healthReason,
    updatedText: account.lastInsightsAt
      ? `Updated ${timeAgo(account.lastInsightsAt)}`
      : "Not updated yet",
    accountTimeLabel:
      account.timezoneName && projectTimezone && projectTimezone !== accountTimezone
        ? `Account time (${accountTimezone})`
        : null,
    runningCampaigns: running,
    agencyLink: AdsFlags.agency(),
    realtime: !AdsFlags.webhooks()
      ? null
      : account.webhookStatus === "SUBSCRIBED"
        ? "on"
        : account.webhookStatus === "POLLING_ONLY"
          ? "polling"
          : null,
    alerts: alerts.map((alert) => ({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
    })),
  };
}
