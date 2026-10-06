import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { formatMoney, toMinorUnits } from "@/lib/ads/money";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsMirror } from "@/server/ads/mirror-reads";
import { prisma } from "@/lib/prisma";

// Sağ dokun Brand sekmesindeki "Ads" kartı (docs/meta-ads-plan.md K22, F6):
// son 7 gün, açık uyarılar ve tazelik. Yalnız aynadan; Meta'ya çağrı yok.

export type AdsOverview =
  | { ok: false; reason: "off" | "not_synced" }
  | {
      ok: true;
      spend: string;
      results: number | null;
      resultLabel: string | null;
      costPerResult: string | null;
      running: number;
      urgent: number;
      updatedAt: string | null;
    };

export async function loadAdsOverview(projectId: string, now: Date = new Date()): Promise<AdsOverview> {
  if (!AdsFlags.sync()) return { ok: false, reason: "off" };
  const account = await AdsMirror.accountFor(projectId);
  if (!account?.lastStructureAt) return { ok: false, reason: "not_synced" };
  const [totals, alerts, running] = await Promise.all([
    AdsMirror.insightsByObject(account, "ACCOUNT", "last_7d", { now }),
    AdsAlerts.listOpen(projectId, 20),
    prisma.adsObject.count({
      where: {
        adsAccountId: account.id,
        level: "CAMPAIGN",
        configuredStatus: "ACTIVE",
        goneAt: null,
        OR: [{ endTime: null }, { endTime: { gt: now } }],
      },
    }),
  ]);
  const row = totals.get(account.externalId);
  const money = (major: number) => formatMoney(toMinorUnits(major, account.currency), account.currency);
  return {
    ok: true,
    spend: money(row?.spend ?? 0),
    results: row?.resultCount ?? null,
    resultLabel: row?.resultLabel ?? null,
    costPerResult: row?.costPerResult !== undefined ? money(row.costPerResult) : null,
    running,
    urgent: alerts.filter((alert) => alert.severity !== "INFO").length,
    updatedAt: account.lastInsightsAt?.toISOString() ?? null,
  };
}
