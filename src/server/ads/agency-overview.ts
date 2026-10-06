import "server-only";

import type { AdsConnection } from "@prisma/client";

import { addDays } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";

// Ajans görünümü (/ads, docs/meta-ads-plan.md F8): workspace'in bütün reklam
// hesapları tek listede: sağlık, son 7 gün harcama, çalışan kampanya, açık
// uyarı, tazelik, gerçek zamanlı uyarı ve otomatik pilot seviyesi. Yalnız
// aynadan okur (Meta'ya çağrı yok).

export type AgencyAccountRow = {
  id: string;
  externalId: string;
  name: string | null;
  currency: string | null;
  healthStatus: string;
  healthReason: string | null;
  lastInsightsAt: Date | null;
  spend7dMinor: number;
  runningCampaigns: number;
  critical: number;
  warn: number;
  webhookStatus: string | null;
  connectionId: string | null;
  projects: { id: string; name: string; autonomy: string }[];
};

export type AgencyOverview = {
  accounts: AgencyAccountRow[];
  connections: AdsConnection[];
};

export async function loadAgencyOverview(
  workspaceId: string,
  now: Date = new Date(),
): Promise<AgencyOverview> {
  const [accounts, connections] = await Promise.all([
    prisma.adsAccount.findMany({
      where: { workspaceId, platform: "META" },
      include: {
        projects: { where: { selected: true }, select: { projectId: true } },
      },
      orderBy: [{ name: "asc" }, { externalId: "asc" }],
      take: 200,
    }),
    prisma.adsConnection.findMany({
      where: { workspaceId, status: { not: "REVOKED" } },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const ids = accounts.map((account) => account.id);
  const projectIds = [
    ...new Set(accounts.flatMap((a) => a.projects.map((p) => p.projectId))),
  ];
  // Son 7 gün (UTC günleri; liste özeti, kesin rakamlar projenin Ads sayfasında).
  const since = new Date(`${addDays(now.toISOString().slice(0, 10), -6)}T00:00:00.000Z`);
  const [spend, running, alerts, projects, policies] = await Promise.all([
    ids.length
      ? prisma.adsInsightDaily.groupBy({
          by: ["adsAccountId"],
          where: {
            adsAccountId: { in: ids },
            level: "ACCOUNT",
            date: { gte: since },
          },
          _sum: { spendMinor: true },
        })
      : [],
    ids.length
      ? prisma.adsObject.groupBy({
          by: ["adsAccountId"],
          where: {
            adsAccountId: { in: ids },
            level: "CAMPAIGN",
            configuredStatus: "ACTIVE",
            goneAt: null,
            OR: [{ endTime: null }, { endTime: { gt: now } }],
          },
          _count: { _all: true },
        })
      : [],
    ids.length
      ? prisma.adsAlert.groupBy({
          by: ["adsAccountId", "severity"],
          where: {
            adsAccountId: { in: ids },
            status: { in: ["OPEN", "ACKED"] },
          },
          _count: { _all: true },
        })
      : [],
    projectIds.length
      ? prisma.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true },
        })
      : [],
    projectIds.length
      ? prisma.autonomyPolicy.findMany({
          where: { projectId: { in: projectIds } },
          select: { projectId: true, adsAutonomy: true },
        })
      : [],
  ]);
  const spendOf = new Map(
    spend.map((row) => [row.adsAccountId, Number(row._sum.spendMinor ?? 0)]),
  );
  const runningOf = new Map(
    running.map((row) => [row.adsAccountId, row._count._all]),
  );
  const nameOf = new Map(projects.map((project) => [project.id, project.name]));
  const autonomyOf = new Map(
    policies.map((policy) => [policy.projectId, policy.adsAutonomy]),
  );
  const alertCount = (accountId: string, severity: string) =>
    alerts
      .filter(
        (row) => row.adsAccountId === accountId && row.severity === severity,
      )
      .reduce((sum, row) => sum + row._count._all, 0);

  return {
    connections,
    accounts: accounts.map((account) => ({
      id: account.id,
      externalId: account.externalId,
      name: account.name,
      currency: account.currency,
      healthStatus: account.healthStatus,
      healthReason: account.healthReason,
      lastInsightsAt: account.lastInsightsAt,
      spend7dMinor: spendOf.get(account.id) ?? 0,
      runningCampaigns: runningOf.get(account.id) ?? 0,
      critical: alertCount(account.id, "CRITICAL"),
      warn: alertCount(account.id, "WARN"),
      webhookStatus: account.webhookStatus,
      connectionId: account.connectionId,
      projects: account.projects.map((link) => ({
        id: link.projectId,
        name: nameOf.get(link.projectId) ?? link.projectId,
        autonomy: autonomyOf.get(link.projectId) ?? "SUGGEST",
      })),
    })),
  };
}
