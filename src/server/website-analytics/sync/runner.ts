import "server-only";

import type { GaPropertyLink, Prisma } from "@prisma/client";

import { backoffMs } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import {
  addonStageDue,
  readAddonState,
} from "@/lib/website-analytics/addon-backfill";
import {
  gaCatalogCheckDue,
  gaDisabledReports,
} from "@/lib/website-analytics/catalog-state";
import { hourInTimezone, safeTimezone } from "@/lib/website-analytics/days";
import { GaFlags, gaSyncAllowedFor } from "@/lib/website-analytics/flags";
import type {
  GaLane,
  GaServerErrors,
  StoredGaQuota,
} from "@/lib/website-analytics/governor";
import {
  GA_REFRESH_EVERY_MS,
  GA_SYNC_LEASE_MS,
  anyGaStageDue,
  dailyAttemptCompletes,
  dueGaStages,
  type GaStages,
} from "@/lib/website-analytics/schedule";
import { gaMockMode } from "@/server/integrations/google-analytics/data-api";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";

import { flushGaApiCounters } from "../api-counters";

import { syncBackfill } from "./backfill";
import { syncCatalogChecks } from "./catalog-checks";
import type { GaSyncContext } from "./context";
import { finalizeDays, syncDaily } from "./daily";
import { ensureGaLinks } from "./links";
import { syncMetadata } from "./metadata";
import { syncMonthly } from "./monthly";
import { GaQuotaDeferred } from "./requests";
import { gaActiveAddonKeys, syncAddons } from "./weekly";

// GA senkronu (docs/google-analytics-plan.md §3.3, §5): `ga-sync` tick adımı.
// Tick başına vadesi gelen en çok 3 bağ; bağ başına 5 dakikalık CAS kilidi
// (syncLeaseUntil aynı zamanda "şu zamana kadar deneme": geri çekilme, kota
// bekletmesi). Sıra: metadata → katalog denetimi → günlük çekim + revizyon
// → kesinleşme → geri doldurma → eklentiler (haftalık, google_ads,
// search_console; yalnız temel geçmiş bitince) → ay özetleri. PAUSED/CLOSED
// projede yalnız metadata ve katalog denetimi çalışır. AGENCY_FOCUS bu adımı
// kapatmaz. Turun sonunda API sayaçları yazılır.

const CANDIDATES = 25;
const LINKS_EVERY_MS = 2 * 60_000;
const STOP_WAIT_MS = 6 * 3_600_000;
const HEARTBEAT_KEY = "ga.sync";

// Kullanıcının düzeltmesi gereken hatalar: senkron 6 saat bekler.
const STOPPING: Partial<Record<GoogleErrorClass, string>> = {
  AUTH: "AUTH",
  SCOPE_MISSING: "NEEDS_PERMISSION",
  PERMISSION: "ACCESS_LOST",
  NOT_FOUND: "GONE",
  API_DISABLED: "API_DISABLED",
};

type CredentialRow = {
  id: string;
  status: string;
  encryptedSecret: string;
};

async function claim(linkId: string, owner: string, now: Date) {
  const claimed = await prisma.gaPropertyLink.updateMany({
    where: {
      id: linkId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    },
    data: {
      syncLeaseUntil: new Date(now.getTime() + GA_SYNC_LEASE_MS),
      syncLeaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

async function release(
  linkId: string,
  owner: string,
  data: Prisma.GaPropertyLinkUpdateManyMutationInput,
): Promise<void> {
  await prisma.gaPropertyLink.updateMany({
    where: { id: linkId, syncLeaseOwner: owner },
    data: { ...data, syncLeaseOwner: null },
  });
}

// GA-F2 bölüm 2 aşamaları (schedule.ts değişmez).
type GaTurnStages = GaStages & { catalog: boolean; addons: boolean };

function stagesFor(
  link: GaPropertyLink,
  now: Date,
  paused: boolean,
): GaTurnStages {
  const timeZone = safeTimezone(link.timeZone);
  const due = dueGaStages(
    {
      lastMetadataAt: link.lastMetadataAt,
      lastDailyAt: link.lastDailyAt,
      lastDailyDate: link.lastDailyDate,
      backfillDone: link.backfillDoneAt !== null,
    },
    { now, timeZone },
  );
  // Katalog denetimi duraklatılmış projede de çalışır.
  const catalog =
    GaFlags.catalogChecks() && gaCatalogCheckDue(link.catalog, now);
  if (paused) {
    return {
      metadata: due.metadata,
      daily: false,
      backfill: false,
      catalog,
      addons: false,
    };
  }
  const addons =
    link.lastDailyAt !== null &&
    link.backfillDoneAt !== null &&
    addonStageDue(
      readAddonState(link.backfill),
      gaActiveAddonKeys(link.catalog, gaDisabledReports(link.catalog)),
      dayKeyInTimezone(now, timeZone),
    );
  return { ...due, catalog, addons };
}

export const GaSync = {
  // Tick adımı.
  async runDue(limit = 3, now: Date = new Date()): Promise<number> {
    if (!GaFlags.sync()) return 0;
    try {
      return await this.runCandidates(limit, now);
    } finally {
      // Turun Google çağrı sayaçları (/health); yazamazsa tur düşmez.
      await flushGaApiCounters();
    }
  },

  async runCandidates(limit: number, now: Date): Promise<number> {
    await Heartbeat.beat(HEARTBEAT_KEY, now);
    if (await claimPeriodic("ga.links", LINKS_EVERY_MS, now)) {
      await ensureGaLinks().catch((error: unknown) => {
        console.error(
          "[ga-sync] links could not be reconciled:",
          error instanceof Error ? error.message : error,
        );
      });
    }

    const candidates = await prisma.gaPropertyLink.findMany({
      where: {
        isPrimary: true,
        OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
      },
      orderBy: [{ lastDailyAt: { sort: "asc", nulls: "first" } }],
      take: CANDIDATES,
    });
    if (candidates.length === 0) {
      await Heartbeat.ok(HEARTBEAT_KEY, now);
      return 0;
    }

    const [credentials, projects] = await Promise.all([
      prisma.integrationCredential.findMany({
        where: { id: { in: candidates.map((link) => link.credentialId) } },
        select: { id: true, status: true, encryptedSecret: true },
      }),
      prisma.project.findMany({
        where: { id: { in: candidates.map((link) => link.projectId) } },
        select: { id: true, status: true },
      }),
    ]);
    const credentialById = new Map(credentials.map((row) => [row.id, row]));
    const projectById = new Map(projects.map((row) => [row.id, row]));

    let processed = 0;
    for (const link of candidates) {
      if (processed >= limit) break;
      if (!gaSyncAllowedFor(link.projectId)) continue;
      const project = projectById.get(link.projectId);
      if (!project) continue;
      const credential = credentialById.get(link.credentialId);
      if (
        !credential ||
        credential.status !== "ACTIVE" ||
        !credential.encryptedSecret
      ) {
        if (link.health !== "AUTH") {
          await prisma.gaPropertyLink.update({
            where: { id: link.id },
            data: {
              health: "AUTH",
              healthReason: "Reconnect Google Analytics",
            },
          });
        }
        continue;
      }
      const paused = project.status === "PAUSED" || project.status === "CLOSED";
      const stages = stagesFor(link, now, paused);
      if (!anyGaStageDue(stages) && !stages.catalog && !stages.addons) {
        continue;
      }

      const owner = `ga-sync:${process.pid}:${now.getTime()}:${link.id}`;
      if (!(await claim(link.id, owner, now))) continue;
      processed += 1;
      await this.syncLink(link, credential, stages, owner, now, "P2");
    }
    await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  async syncLink(
    link: GaPropertyLink,
    credential: CredentialRow,
    stages: GaTurnStages,
    owner: string,
    now: Date,
    lane: GaLane,
  ): Promise<void> {
    const timeZone = safeTimezone(link.timeZone);
    const ctx: GaSyncContext = {
      link,
      accessToken: "",
      timeZone,
      today: dayKeyInTimezone(now, timeZone),
      now,
      lane,
      disabled: gaDisabledReports(link.catalog),
      quota: (link.lastQuota ?? null) as StoredGaQuota | null,
      serverErrors: (link.serverErrorsHour ?? null) as GaServerErrors | null,
      rateLimitedUntil: link.rateLimitedUntil,
    };
    try {
      ctx.accessToken = gaMockMode()
        ? "mock-access-token"
        : await getFreshGoogleAccessToken(credential);
      // Günlük çekimin günü mülkün saat dilimine bağlı: önce metadata.
      if (stages.metadata || !link.timeZone) await syncMetadata(ctx);
      // GA-F2b: haftalık katalog denetimi (getMetadata/checkCompatibility).
      if (stages.catalog) await syncCatalogChecks(ctx);
      if (stages.daily) {
        const { yesterdayIn } = await syncDaily(ctx);
        const complete = dailyAttemptCompletes({
          hour: hourInTimezone(now, ctx.timeZone),
          yesterdayIn,
        });
        ctx.link = await prisma.gaPropertyLink.update({
          where: { id: link.id },
          data: {
            lastDailyAt: now,
            ...(complete ? { lastDailyDate: ctx.today } : {}),
          },
        });
        await finalizeDays(ctx);
      }
      if (stages.backfill) await syncBackfill(ctx);
      if (stages.addons) await syncAddons(ctx);
      if (stages.daily || stages.backfill || stages.addons) {
        await syncMonthly(ctx);
      }
      await release(link.id, owner, {
        syncLeaseUntil: null,
        consecutiveFailures: 0,
        health: "OK",
        healthReason: null,
        lastSyncError: null,
      });
    } catch (error) {
      await this.onFailure(ctx, owner, error);
    }
  },

  // "Refresh" (Website sayfası; P1): son 7 gün yeniden çekilir, bağ başına
  // en çok 5 dakikada bir.
  async refreshNow(
    projectId: string,
    now: Date = new Date(),
  ): Promise<"refreshed" | "throttled" | "busy" | "unavailable"> {
    if (!GaFlags.sync() || !gaSyncAllowedFor(projectId)) return "unavailable";
    const link = await prisma.gaPropertyLink.findFirst({
      where: { projectId, isPrimary: true },
    });
    if (!link) return "unavailable";
    if (
      link.lastDailyAt &&
      now.getTime() - link.lastDailyAt.getTime() < GA_REFRESH_EVERY_MS
    ) {
      return "throttled";
    }
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: link.credentialId },
      select: { id: true, status: true, encryptedSecret: true },
    });
    if (!credential || credential.status !== "ACTIVE") return "unavailable";
    const owner = `ga-refresh:${process.pid}:${now.getTime()}:${link.id}`;
    if (!(await claim(link.id, owner, now))) return "busy";
    await this.syncLink(
      link,
      credential,
      {
        metadata: !link.lastMetadataAt,
        daily: true,
        backfill: false,
        catalog: false,
        addons: false,
      },
      owner,
      now,
      "P1",
    );
    const after = await prisma.gaPropertyLink.findUnique({
      where: { id: link.id },
      select: { lastDailyAt: true },
    });
    return after?.lastDailyAt && after.lastDailyAt.getTime() >= now.getTime()
      ? "refreshed"
      : "busy";
  },

  async onFailure(
    ctx: GaSyncContext,
    owner: string,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    if (error instanceof GaQuotaDeferred) {
      await release(ctx.link.id, owner, { syncLeaseUntil: error.retryAt });
      return;
    }
    const klass: GoogleErrorClass =
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    if (klass === "RATE_LIMIT" || klass === "QUOTA_DAILY") {
      await release(ctx.link.id, owner, {
        syncLeaseUntil:
          ctx.rateLimitedUntil ?? new Date(now.getTime() + 15 * 60_000),
      });
      return;
    }
    const failures = ctx.link.consecutiveFailures + 1;
    const stopping = STOPPING[klass];
    await release(ctx.link.id, owner, {
      syncLeaseUntil: new Date(
        now.getTime() + (stopping ? STOP_WAIT_MS : backoffMs(failures)),
      ),
      consecutiveFailures: { increment: 1 },
      ...(stopping
        ? { health: stopping, healthReason: message.slice(0, 300) }
        : failures >= 3
          ? { health: "DEGRADED", healthReason: message.slice(0, 300) }
          : {}),
      lastSyncError: message.slice(0, 500),
    });
    console.error(
      `[ga-sync] property ${ctx.link.propertyId} failed (${klass}, attempt ${failures}): ${message}`,
    );
  },
};
