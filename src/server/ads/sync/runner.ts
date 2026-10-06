import "server-only";

import type { AdsAccount } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import {
  addDays,
  anyStageDue,
  backoffMs,
  BACKFILL_DAYS,
  dayRanges,
  dueStages,
  hourInTimezone,
  INITIAL_DAYS,
  safeTimezone,
  SYNC_LEASE_MS,
  type SyncStages,
} from "@/lib/ads/sync-plan";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { AdsGuard } from "@/server/ads/guard/watchdogs";
import { markMetaCredentialExpiredOn } from "@/server/integrations/meta-credential-health";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { classifyMetaError } from "@/server/integrations/meta/error-catalog";
import { MetaRateLimitedError } from "@/server/integrations/meta/governor";
import { decryptSecret } from "@/server/security/crypto";

import type { SyncContext, SyncProject } from "./context";
import { syncAccountHealth } from "./health";
import { backfillDeletedObjects, syncInsightsRange } from "./insights";
import { syncStructure } from "./structure";

// Ayna senkronu (docs/meta-ads-plan.md §3.2): tick adımı ve hesap kilidi.
// Kilit Meta hesabı başınadır (aynı hesap birden çok projeye bağlıysa tek kez
// senkronlanır); syncLeaseUntil hem kilit hem "şu zamana kadar deneme"
// (geri çekilme, kota bloğu) olarak kullanılır. Senkron Project.status'tan
// bağımsızdır: proje duraklatılmış olsa bile hesapta son 7 günde harcama
// varsa izleme sürer.

const CANDIDATES = 25;
const REFRESH_EVERY_MS = 5 * 60_000;
const DORMANT_SPEND_DAYS = 7;

type Candidate = AdsAccount & {
  projects: { projectId: string; brandId: string }[];
};

async function claim(accountId: string, owner: string, now: Date): Promise<boolean> {
  const claimed = await prisma.adsAccount.updateMany({
    where: {
      id: accountId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    },
    data: {
      syncLeaseUntil: new Date(now.getTime() + SYNC_LEASE_MS),
      syncLeaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

async function release(
  accountId: string,
  owner: string,
  data: { syncLeaseUntil: Date | null; consecutiveFailures?: number | { increment: number } },
): Promise<void> {
  await prisma.adsAccount.updateMany({
    where: { id: accountId, syncLeaseOwner: owner },
    data: { ...data, syncLeaseOwner: null },
  });
}

async function projectsOf(candidate: Candidate): Promise<SyncProject[]> {
  if (candidate.projects.length === 0) return [];
  const rows = await prisma.project.findMany({
    where: { id: { in: candidate.projects.map((link) => link.projectId) } },
    select: { id: true, workspaceId: true, name: true, status: true },
  });
  const brandOf = new Map(candidate.projects.map((link) => [link.projectId, link.brandId]));
  return rows.map((row) => ({
    projectId: row.id,
    workspaceId: row.workspaceId,
    brandId: brandOf.get(row.id) ?? "",
    name: row.name,
    status: row.status,
  }));
}

async function recentSpend(accountId: string, today: string): Promise<number> {
  const since = new Date(`${addDays(today, -DORMANT_SPEND_DAYS)}T00:00:00.000Z`);
  const total = await prisma.adsInsightDaily.aggregate({
    where: { adsAccountId: accountId, level: "ACCOUNT", date: { gte: since } },
    _sum: { spendMinor: true },
  });
  return Number(total._sum.spendMinor ?? 0);
}

export const AdsSync = {
  // Tick adımı: vadesi gelen en çok `limit` hesap.
  async runDue(limit = 3, now: Date = new Date()): Promise<number> {
    if (!AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;

    const candidates: Candidate[] = await prisma.adsAccount.findMany({
      where: {
        platform: "META",
        credentialId: { not: null },
        OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
        projects: { some: { selected: true } },
      },
      include: {
        projects: {
          where: { selected: true },
          select: { projectId: true, brandId: true },
        },
      },
      orderBy: [{ lastInsightsAt: { sort: "asc", nulls: "first" } }],
      take: CANDIDATES,
    });
    if (candidates.length === 0) return 0;

    const credentials = await prisma.integrationCredential.findMany({
      where: {
        id: {
          in: candidates
            .map((row) => row.credentialId)
            .filter((id): id is string => Boolean(id)),
        },
      },
      select: { id: true, status: true, encryptedSecret: true },
    });
    const credentialById = new Map(credentials.map((row) => [row.id, row]));
    const delivering = await prisma.adsObject.groupBy({
      by: ["adsAccountId"],
      where: {
        adsAccountId: { in: candidates.map((row) => row.id) },
        level: "ADSET",
        effectiveStatus: "ACTIVE",
        goneAt: null,
        OR: [{ endTime: null }, { endTime: { gt: now } }],
      },
      _count: { _all: true },
    });
    const deliveringIds = new Set(delivering.map((row) => row.adsAccountId));

    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= limit) break;
      const credential = candidate.credentialId
        ? credentialById.get(candidate.credentialId)
        : undefined;
      if (!credential || credential.status !== "ACTIVE" || !credential.encryptedSecret) {
        if (candidate.healthStatus !== "AUTH") {
          await prisma.adsAccount.update({
            where: { id: candidate.id },
            data: { healthStatus: "AUTH", healthReason: "Reconnect Meta Ads" },
          });
        }
        continue;
      }
      const timezone = safeTimezone(candidate.timezoneName);
      const today = dayKeyInTimezone(now, timezone);
      const stages = dueStages({
        now,
        lastHealthAt: candidate.lastHealthAt,
        lastStructureAt: candidate.lastStructureAt,
        lastInsightsAt: candidate.lastInsightsAt,
        lastBackfillDate: candidate.lastBackfillDate,
        activeDelivery: deliveringIds.has(candidate.id),
        accountToday: today,
        accountHour: hourInTimezone(now, timezone),
      });
      if (!anyStageDue(stages)) continue;

      const owner = `sync:${process.pid}:${now.getTime()}:${candidate.id}`;
      if (!(await claim(candidate.id, owner, now))) continue;
      processed += 1;
      await this.syncAccount(candidate, decryptSecret(credential.encryptedSecret), stages, owner, now);
    }
    return processed;
  },

  async syncAccount(
    candidate: Candidate,
    accessToken: string,
    stages: SyncStages,
    owner: string,
    now: Date,
    lane: "P1_USER" | "P2_BACKGROUND" = "P2_BACKGROUND",
  ): Promise<void> {
    const projects = await projectsOf(candidate);
    const timezone = safeTimezone(candidate.timezoneName);
    const ctx: SyncContext = {
      account: candidate,
      accessToken,
      externalId: candidate.externalId,
      currency: candidate.currency,
      timezone,
      today: dayKeyInTimezone(now, timezone),
      now,
      projects,
      primaryProjectId: projects[0]?.projectId ?? null,
    };

    // Bütün projeleri duraklatılmış / kapatılmış ve son 7 günde harcaması
    // olmayan hesap: yalnız sağlık okunur.
    const dormant =
      projects.length > 0 &&
      projects.every((project) => project.status === "PAUSED" || project.status === "CLOSED") &&
      candidate.lastStructureAt !== null &&
      (await recentSpend(candidate.id, ctx.today)) === 0;

    try {
      await withMetaCallContext(
        { account: ctx.externalId, lane, callSite: lane === "P1_USER" ? "ads-refresh" : "ads-sync" },
        async () => {
          if (stages.health) await syncAccountHealth(ctx);
          if (dormant) return;
          if (stages.structure) await syncStructure(ctx);
          if (stages.insights) {
            await syncInsightsRange(ctx, { since: ctx.today, until: ctx.today });
            await prisma.adsAccount.update({
              where: { id: ctx.account.id },
              data: { lastInsightsAt: now },
            });
          }
          if (stages.backfill !== "none") {
            const days = stages.backfill === "initial" ? INITIAL_DAYS : BACKFILL_DAYS;
            const since = addDays(ctx.today, -days);
            const until = addDays(ctx.today, -1);
            for (const range of dayRanges(since, until)) {
              await syncInsightsRange(ctx, range);
            }
            await backfillDeletedObjects(ctx, { since: addDays(ctx.today, -BACKFILL_DAYS), until });
            await prisma.adsAccount.update({
              where: { id: ctx.account.id },
              data: { lastBackfillDate: ctx.today },
            });
          }
        },
      );
      await release(candidate.id, owner, { syncLeaseUntil: null, consecutiveFailures: 0 });
      await AdsGuard.evaluateAccount(ctx).catch((error: unknown) => {
        console.error(
          `[ads-sync] guard failed for ${ctx.externalId}:`,
          error instanceof Error ? error.message : error,
        );
      });
    } catch (error) {
      await this.onFailure(candidate, owner, error, now);
    }
  },

  // "Refresh" düğmesi (docs/meta-ads-plan.md §3.2): kullanıcının beklediği
  // okuma P1 şeridinde, hesap başına en çok 5 dakikada bir.
  async refreshNow(
    projectId: string,
    now: Date = new Date(),
  ): Promise<"refreshed" | "throttled" | "busy" | "unavailable"> {
    if (!AdsFlags.sync()) return "unavailable";
    const link = await prisma.adsAccountProject.findFirst({
      where: { projectId, selected: true },
      include: {
        adsAccount: {
          include: {
            projects: {
              where: { selected: true },
              select: { projectId: true, brandId: true },
            },
          },
        },
      },
    });
    const account = link?.adsAccount;
    if (!account?.credentialId) return "unavailable";
    if (
      account.lastInsightsAt &&
      now.getTime() - account.lastInsightsAt.getTime() < REFRESH_EVERY_MS
    ) {
      return "throttled";
    }
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: account.credentialId },
      select: { status: true, encryptedSecret: true },
    });
    if (!credential || credential.status !== "ACTIVE") return "unavailable";
    const owner = `refresh:${process.pid}:${now.getTime()}:${account.id}`;
    if (!(await claim(account.id, owner, now))) return "busy";
    const stages: SyncStages = {
      health: !account.lastHealthAt,
      structure: true,
      insights: true,
      backfill: account.lastBackfillDate ? "none" : "initial",
    };
    await this.syncAccount(
      account,
      decryptSecret(credential.encryptedSecret),
      stages,
      owner,
      now,
      "P1_USER",
    );
    const after = await prisma.adsAccount.findUnique({
      where: { id: account.id },
      select: { lastInsightsAt: true },
    });
    return after?.lastInsightsAt && after.lastInsightsAt.getTime() >= now.getTime()
      ? "refreshed"
      : "busy";
  },

  async onFailure(
    candidate: Candidate,
    owner: string,
    error: unknown,
    now: Date,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    // Kota: geri çekilme değil, Meta'nın blok süresi.
    if (error instanceof MetaRateLimitedError) {
      await release(candidate.id, owner, { syncLeaseUntil: error.retryAt });
      return;
    }
    const { class: klass } = classifyMetaError(error, "ads_insights");
    if (klass === "RATE_LIMIT") {
      const blocked = await prisma.adsAccount.findUnique({
        where: { id: candidate.id },
        select: { rateLimitedUntil: true },
      });
      await release(candidate.id, owner, {
        syncLeaseUntil: blocked?.rateLimitedUntil ?? new Date(now.getTime() + 5 * 60_000),
      });
      return;
    }
    if (klass === "AUTH" && candidate.credentialId) {
      // 190: bağlantı EXPIRED, senkron durur (aday sorgusu ACTIVE ister).
      await markMetaCredentialExpiredOn(error, candidate.credentialId);
      await prisma.adsAccount.update({
        where: { id: candidate.id },
        data: { healthStatus: "AUTH", healthReason: "Reconnect Meta Ads" },
      });
    }
    const failures = candidate.consecutiveFailures + 1;
    await release(candidate.id, owner, {
      syncLeaseUntil: new Date(now.getTime() + backoffMs(failures)),
      consecutiveFailures: { increment: 1 },
    });
    console.error(
      `[ads-sync] ${candidate.externalId} failed (${klass}, attempt ${failures}): ${message}`,
    );
  },
};
