import "server-only";

import type { GscSiteLink, Prisma } from "@prisma/client";

import { backoffMs } from "@/lib/ads/sync-plan";
import {
  brandKeyDone,
  parseGscBackfillState,
  retargetBrand,
  type GscBackfillState,
} from "@/lib/seo/backfill";
import { addDays, googleWindowStart, gscToday } from "@/lib/seo/dates";
import {
  GscFlags,
  gscGlobalWorkAllowedHere,
  gscRestrictedProjects,
  gscSyncAllowedFor,
} from "@/lib/seo/flags";
import { heavyBlocked, quotaStateOf } from "@/lib/seo/governor";
import { GscAgencyFlags } from "@/lib/seo/agency/flags";
import {
  GSC_DAILY_WINDOW_DAYS,
  GSC_REFRESH_BUDGET_MS,
  GSC_REFRESH_EVERY_MS,
  GSC_RUN_REQUESTS,
  GSC_SYNC_LEASE_MS,
  GSC_TICK_BUDGET_MS,
  anyGscStageDue,
  dueGscStages,
  type GscStages,
} from "@/lib/seo/schedule";
import { prisma } from "@/lib/prisma";
import type { GoogleErrorClass } from "@/server/integrations/google/error-catalog";
import { GoogleApiError } from "@/server/integrations/google/errors";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";
import { brandContextForLink } from "@/server/seo/brand-terms";

import { syncBackfill } from "./backfill";
import { parseSearchTypes, type GscSyncContext } from "./context";
import { syncDaily } from "./daily";
import { clearBrandSeries } from "./write";
import { ensureGscLinkForProject, ensureGscLinks } from "./links";
import { syncMetadata } from "./metadata";
import { syncMonthly } from "./monthly";
import { GscQuotaDeferred, GscRunBudgetSpent } from "./requests";
import { syncWeekly } from "./weekly";

// Search Console senkronu (docs/google-search-console-plan.md §3.3, §5;
// docs/search-analytics.md "Senkron"): `gsc-sync` tick adımı. Tick başına
// vadesi gelen en çok 3 bağ, bağ başına 5 dakikalık CAS kilidi
// (syncLeaseUntil aynı zamanda "şu zamana kadar deneme": geri çekilme, kota
// bekletmesi). Sıra: metadata → günlük (kesin + taze, boşluk tespiti) →
// haftalık → aylık → geri doldurma. Bütün bağlar tek bir 90 sn'lik süreyi ve
// bağ başına 45 isteklik bütçeyi paylaşır. Ağır blok yalnız o aşamayı bitirir.
// PAUSED/CLOSED projede yalnız metadata okunur (kaçan günleri devam edince
// boşluk tespiti doldurur). AGENCY_FOCUS bu adımı kapatmaz.

const CANDIDATES = 25;
const BACKFILL_CANDIDATES = 10;
// SC-F9: ikincil siteler ayrı küçük sorgulardan gelir, birincil pencereyi
// kalabalıklaştırmaz; tick başına en çok SECONDARY_PER_TICK'i işlenir.
const SECONDARY_CANDIDATES = 6;
const SECONDARY_BACKFILL_CANDIDATES = 3;
const SECONDARY_PER_TICK = 2;
const LINKS_EVERY_MS = 2 * 60_000;
const STOP_WAIT_MS = 6 * 3_600_000;
const QUOTA_FALLBACK_MS = 15 * 60_000;
const HEARTBEAT_KEY = "gsc.sync";

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

// Geliştirme süreci (canlı veritabanı paylaşılırken) izinli projelerin
// bağlarını kendisi kurar; claimPeriodic anahtarı almaz.
let lastDevReconcileAt = 0;

async function claim(linkId: string, owner: string, now: Date) {
  const claimed = await prisma.gscSiteLink.updateMany({
    where: {
      id: linkId,
      OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    },
    data: {
      syncLeaseUntil: new Date(now.getTime() + GSC_SYNC_LEASE_MS),
      syncLeaseOwner: owner,
    },
  });
  return claimed.count === 1;
}

async function release(
  linkId: string,
  owner: string,
  data: Prisma.GscSiteLinkUpdateManyMutationInput,
): Promise<void> {
  await prisma.gscSiteLink.updateMany({
    where: { id: linkId, syncLeaseOwner: owner },
    data: { ...data, syncLeaseOwner: null },
  });
}

function stagesFor(link: GscSiteLink, now: Date): GscStages {
  const state = parseGscBackfillState(link.backfill);
  return dueGscStages(
    {
      lastMetadataAt: link.lastMetadataAt,
      lastDailyAt: link.lastDailyAt,
      lastDailySlot: link.lastDailySlot,
      lastFinalDate: link.lastFinalDate,
      lastWeeklyWeek: link.lastWeeklyWeek,
      lastMonthlyMonth: link.lastMonthlyMonth,
      backfillDone: link.backfillDoneAt !== null,
      // Yeniden açılan marka anahtarı ve kaydedilmiş yeni terimler
      // (brandClassifiedHash = null) boşluk gibi sayılır: geçmiş bitmiş olsa da
      // geri doldurma (ve başındaki marka planı) bir sonraki tick'te çalışır.
      gapCount:
        (state?.gaps.length ?? 0) +
        (state && !brandKeyDone(state) ? 1 : 0) +
        (state && link.brandClassifiedHash === null ? 1 : 0),
      heavyPending: state?.heavyPending.length ?? 0,
      heavyBlocked: heavyBlocked(quotaStateOf(link), now),
    },
    now,
  );
}

async function reconcileLinks(global: boolean, now: Date): Promise<void> {
  const report = (error: unknown) => {
    console.error(
      "[gsc-sync] links could not be reconciled:",
      error instanceof Error ? error.message : error,
    );
  };
  if (global) {
    if (await claimPeriodic("gsc.links", LINKS_EVERY_MS, now)) {
      await ensureGscLinks().catch(report);
    }
    return;
  }
  if (Date.now() - lastDevReconcileAt < LINKS_EVERY_MS) return;
  lastDevReconcileAt = Date.now();
  for (const projectId of gscRestrictedProjects() ?? []) {
    await ensureGscLinkForProject(projectId).catch(report);
  }
}

async function candidateLinks(now: Date): Promise<GscSiteLink[]> {
  const restricted = gscRestrictedProjects();
  const where: Prisma.GscSiteLinkWhereInput = {
    isPrimary: true,
    isMock: gscMockMode(),
    OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    ...(restricted ? { projectId: { in: restricted } } : {}),
  };
  const agency = GscAgencyFlags.on();
  const secondaryWhere: Prisma.GscSiteLinkWhereInput = {
    isPrimary: false,
    isSecondary: true,
    isMock: gscMockMode(),
    OR: [{ syncLeaseUntil: null }, { syncLeaseUntil: { lt: now } }],
    ...(restricted ? { projectId: { in: restricted } } : {}),
  };
  const [oldest, backfilling, secondaryOldest, secondaryBackfilling] =
    await Promise.all([
      prisma.gscSiteLink.findMany({
        where,
        orderBy: [{ lastDailyAt: { sort: "asc", nulls: "first" } }],
        take: CANDIDATES,
      }),
      // Ajans ölçeğinde geri dolduran bağlar aç kalmasın.
      prisma.gscSiteLink.findMany({
        where: { ...where, backfillDoneAt: null },
        orderBy: [{ updatedAt: "asc" }],
        take: BACKFILL_CANDIDATES,
      }),
      // SC-F9: bayrak kapalıyken bu iki sorgu hiç çalışmaz.
      agency
        ? prisma.gscSiteLink.findMany({
            where: secondaryWhere,
            orderBy: [{ lastDailyAt: { sort: "asc", nulls: "first" } }],
            take: SECONDARY_CANDIDATES,
          })
        : Promise.resolve([] as GscSiteLink[]),
      agency
        ? prisma.gscSiteLink.findMany({
            where: { ...secondaryWhere, backfillDoneAt: null },
            orderBy: [{ updatedAt: "asc" }],
            take: SECONDARY_BACKFILL_CANDIDATES,
          })
        : Promise.resolve([] as GscSiteLink[]),
    ]);
  const dedupe = (rows: GscSiteLink[]): GscSiteLink[] => {
    const seen = new Set<string>();
    return rows.filter((link) => {
      if (seen.has(link.id)) return false;
      seen.add(link.id);
      return true;
    });
  };
  const links = dedupe([...oldest, ...backfilling]);
  // Günlük çekimi gelenler önce.
  const dailyDue = (link: GscSiteLink) => stagesFor(link, now).daily;
  // İkincil siteler HER ZAMAN bütün birincil adaylardan sonra gelir.
  return [
    ...links.filter(dailyDue),
    ...links.filter((link) => !dailyDue(link)),
    ...dedupe([...secondaryOldest, ...secondaryBackfilling]),
  ];
}

async function reread(ctx: GscSyncContext): Promise<void> {
  const fresh = await prisma.gscSiteLink.findUnique({
    where: { id: ctx.link.id },
  });
  if (fresh) ctx.link = fresh;
}

export const GscSync = {
  // Tick adımı.
  async runDue(limit = 3, now: Date = new Date()): Promise<number> {
    if (!GscFlags.sync()) return 0;
    const global = gscGlobalWorkAllowedHere();
    if (global) await Heartbeat.beat(HEARTBEAT_KEY, now);
    await reconcileLinks(global, now);
    const restricted = gscRestrictedProjects();
    if (restricted && restricted.length === 0) {
      if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
      return 0;
    }

    const tickDeadline = Date.now() + GSC_TICK_BUDGET_MS;
    const candidates = await candidateLinks(now);
    if (candidates.length === 0) {
      if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
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
    let secondaryDone = 0;
    for (const link of candidates) {
      if (processed >= limit || Date.now() >= tickDeadline) break;
      if (!gscSyncAllowedFor(link.projectId)) continue;
      if (link.isSecondary && secondaryDone >= SECONDARY_PER_TICK) continue;
      const project = projectById.get(link.projectId);
      if (!project) continue;
      const credential = credentialById.get(link.credentialId);
      if (
        !credential ||
        credential.status !== "ACTIVE" ||
        !credential.encryptedSecret
      ) {
        if (link.health !== "AUTH") {
          await prisma.gscSiteLink.update({
            where: { id: link.id },
            data: { health: "AUTH", healthReason: "Reconnect Search Console" },
          });
        }
        continue;
      }
      const due = stagesFor(link, now);
      const paused = project.status === "PAUSED" || project.status === "CLOSED";
      const stages: GscStages = paused
        ? {
            metadata: due.metadata,
            daily: false,
            weekly: false,
            monthly: false,
            backfill: false,
          }
        : due;
      if (!anyGscStageDue(stages)) continue;

      const owner = `gsc-sync:${process.pid}:${now.getTime()}:${link.id}`;
      if (!(await claim(link.id, owner, now))) continue;
      processed += 1;
      if (link.isSecondary) secondaryDone += 1;
      await this.syncLink(link, credential, stages, owner, now, {
        lane: "P2",
        requests: GSC_RUN_REQUESTS.P2,
        deadline: tickDeadline,
        recompute: !paused,
      });
    }
    if (global) await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  async syncLink(
    link: GscSiteLink,
    credential: CredentialRow,
    stages: GscStages,
    owner: string,
    now: Date,
    run: {
      lane: "P1" | "P2";
      requests: number;
      deadline: number;
      // Günlük aşamadan sonra diğer aşamalar yeniden hesaplanır (yeni bağ
      // hepsine aynı turda başlar). Refresh'te kapalı.
      recompute: boolean;
    },
    // "done": bütün aşamalar bitti; "partial": istek bütçesi bitti (yazılan
    // yazıldı, kalan sonraki turda); "failed": hata, onFailure işledi.
  ): Promise<"done" | "partial" | "failed"> {
    const ctx: GscSyncContext = {
      link,
      accessToken: "",
      now,
      today: gscToday(now),
      lane: run.lane,
      deadline: run.deadline,
      quota: quotaStateOf(link),
      requestsLeft: run.requests,
      brand: null,
      searchTypes: parseSearchTypes(link.searchTypes),
    };
    // Ağır blok yalnız o aşamayı bitirir; sonraki aşamalar sürer.
    const stage = async (step: () => Promise<void>) => {
      try {
        await step();
      } catch (error) {
        if (!(error instanceof GscQuotaDeferred && error.reason === "HEAVY")) {
          throw error;
        }
      }
      await reread(ctx);
    };
    try {
      ctx.accessToken = gscMockMode()
        ? "mock-access-token"
        : await getFreshGoogleAccessToken(credential);
      ctx.brand = await brandContextForLink(link, {
        refresh: stages.metadata,
        now,
      }).catch((error: unknown) => {
        console.warn(
          `[gsc-sync] brand terms unavailable for site ${link.siteUrl}:`,
          error instanceof Error ? error.message : error,
        );
        return null;
      });
      await reread(ctx);
      const retargeted = await this.planBrand(ctx);

      let due: GscStages =
        retargeted && run.recompute ? { ...stages, backfill: true } : stages;
      if (stages.metadata) await stage(() => syncMetadata(ctx));
      if (stages.daily) {
        await stage(() => syncDaily(ctx));
        if (run.recompute) {
          const after = stagesFor(ctx.link, now);
          due = {
            ...due,
            weekly: due.weekly || after.weekly,
            monthly: due.monthly || after.monthly,
            backfill: due.backfill || after.backfill,
          };
        }
      }
      if (due.weekly) await stage(() => syncWeekly(ctx));
      if (due.monthly) await stage(() => syncMonthly(ctx));
      if (due.backfill) await stage(() => syncBackfill(ctx));
      await this.succeed(ctx, owner);
      return "done";
    } catch (error) {
      if (error instanceof GscRunBudgetSpent) {
        await this.succeed(ctx, owner);
        return "partial";
      }
      await this.onFailure(ctx, owner, error);
      return "failed";
    }
  },

  async succeed(ctx: GscSyncContext, owner: string): Promise<void> {
    await release(ctx.link.id, owner, {
      syncLeaseUntil: null,
      consecutiveFailures: 0,
      health: "OK",
      healthReason: null,
      lastSyncError: null,
    });
  },

  // Marka terimleri değiştiyse geri doldurmanın 'brand' anahtarı yeni özetle
  // yeniden açılır; terim kalmadıysa seri temizlenir. Dönüş: değişti mi.
  async planBrand(ctx: GscSyncContext): Promise<boolean> {
    const brand = ctx.brand;
    const state: GscBackfillState | null = parseGscBackfillState(
      ctx.link.backfill,
    );
    if (!brand || !state) return false;
    const hasRegex = brand.regex !== null;
    const { state: next, changed } = retargetBrand(state, {
      hash: brand.hash,
      hasRegex,
      floor: googleWindowStart(ctx.today),
      end: addDays(ctx.today, -GSC_DAILY_WINDOW_DAYS - 1),
    });
    if (!changed) return false;
    if (!hasRegex) await clearBrandSeries(ctx.link.id);
    ctx.link = await prisma.gscSiteLink.update({
      where: { id: ctx.link.id },
      data: {
        backfill: next as unknown as Prisma.InputJsonValue,
        ...(!hasRegex
          ? { brandSeriesHash: "none" }
          : ctx.link.brandSeriesHash === "error"
            ? { brandSeriesHash: null }
            : {}),
      },
    });
    return true;
  },

  // "Refresh" (Search sayfası; P1): günlük pencere yeniden çekilir, bağ
  // başına en çok 5 dakikada bir.
  async refreshNow(
    projectId: string,
    now: Date = new Date(),
  ): Promise<"refreshed" | "throttled" | "busy" | "failed" | "unavailable"> {
    if (!GscFlags.sync() || !gscSyncAllowedFor(projectId)) {
      return "unavailable";
    }
    const link = await prisma.gscSiteLink.findFirst({
      where: { projectId, isPrimary: true, isMock: gscMockMode() },
      orderBy: { updatedAt: "desc" },
    });
    if (!link) return "unavailable";
    if (
      link.lastDailyAt &&
      now.getTime() - link.lastDailyAt.getTime() < GSC_REFRESH_EVERY_MS
    ) {
      return "throttled";
    }
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: link.credentialId },
      select: { id: true, status: true, encryptedSecret: true },
    });
    if (!credential || credential.status !== "ACTIVE") return "unavailable";
    const owner = `gsc-refresh:${process.pid}:${now.getTime()}:${link.id}`;
    if (!(await claim(link.id, owner, now))) return "busy";
    const outcome = await this.syncLink(
      link,
      credential,
      {
        metadata: !link.lastMetadataAt,
        daily: true,
        weekly: false,
        monthly: false,
        backfill: false,
      },
      owner,
      now,
      {
        lane: "P1",
        requests: GSC_RUN_REQUESTS.P1,
        deadline: Date.now() + GSC_REFRESH_BUDGET_MS,
        recompute: false,
      },
    );
    // Kilit bizdeydi: "busy" artık doğru değil. Bütçe bittiyse (ör. gün gün
    // görünüm istekleri) yazılan veri yazıldı, kalan sonraki turda tamamlanır.
    return outcome === "failed" ? "failed" : "refreshed";
  },

  async onFailure(
    ctx: GscSyncContext,
    owner: string,
    error: unknown,
  ): Promise<void> {
    const now = new Date();
    if (error instanceof GscQuotaDeferred) {
      // Ağır blok bağı kilitlemez: en çok bir kilit süresi beklenir.
      const retryAt =
        error.reason === "HEAVY"
          ? new Date(
              Math.min(
                error.retryAt.getTime(),
                now.getTime() + GSC_SYNC_LEASE_MS,
              ),
            )
          : error.retryAt;
      await release(ctx.link.id, owner, { syncLeaseUntil: retryAt });
      return;
    }
    const klass: GoogleErrorClass =
      error instanceof GoogleApiError ? error.errorClass : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    if (klass === "RATE_LIMIT" || klass === "QUOTA_DAILY") {
      const blocks = [ctx.quota.rateLimitedUntil, ctx.quota.loadLimitedUntil]
        .filter((until): until is Date => until !== null)
        .map((until) => until.getTime())
        .filter((until) => until > now.getTime());
      await release(ctx.link.id, owner, {
        syncLeaseUntil: new Date(
          blocks.length > 0
            ? Math.max(...blocks)
            : now.getTime() + QUOTA_FALLBACK_MS,
        ),
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
      `[gsc-sync] site ${ctx.link.siteUrl} failed (${klass}, attempt ${failures}): ${message}`,
    );
  },
};
