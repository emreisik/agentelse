import "server-only";

import type { GaHealthRun, GaPropertyLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { gaEngineLinkWhere } from "@/lib/website-analytics/agency/scope";
import { hourInTimezone, safeTimezone } from "@/lib/website-analytics/days";
import {
  gaGlobalWorkAllowedHere,
  gaSyncAllowedFor,
} from "@/lib/website-analytics/flags";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
import { realtimeProbeDue } from "@/lib/website-analytics/health/realtime-state";
import {
  GA_HEALTH_LEASE_MS,
  gaHealthDue,
  gaHealthFingerprint,
  recheckThrottledUntil,
} from "@/lib/website-analytics/health/schedule";
import { parseGaRealtimeState } from "@/lib/website-analytics/health/stored";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { Heartbeat } from "@/server/observability/heartbeat";
import { claimPeriodic } from "@/server/observability/periodic";
import { primaryGaLink } from "@/server/website-analytics/store";

import { evaluateGaLink, evaluateGaRealtime, gaLinkReachable } from "./checks";

// GA-F3 ölçüm sağlığı (docs/measurement-health.md): `ga-health` tick adımı,
// `ga-sync`'ten sonra. Tick başına en çok 5 birincil bağ; sıra veritabanında
// GaHealthRun.evaluatedAt'e göre (hiç değerlendirilmemiş önce). Tam
// değerlendirme parmak izi değişince, 6 saatte bir ve "I fixed it"
// isteğinde; arada vadesi gelen bağlar yalnız-realtime yolundan geçer.
// GaHealthRun satırında 3 dakikalık CAS kilidi. PAUSED/CLOSED proje
// atlanır; tick başına en çok bir gerçek site taraması. Günlük temizlik
// (yalnız canlıda): sahipsiz GA4 uyarıları çözülür, 180 günlük çözülmüş
// uyarılar silinir. GA_HEALTH kapalıyken hiçbir sorgu yok.

const CANDIDATES = 200;
const HEARTBEAT_KEY = "ga.health";
const HOUSEKEEPING_KEY = "ga.health.housekeeping";
const HOUSEKEEPING_EVERY_MS = 24 * 3_600_000;
const RESOLVED_KEEP_DAYS = 180;

type CandidateLink = GaPropertyLink & { healthRun: GaHealthRun | null };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Satır yoksa oluşturur; iki süreç aynı anda oluşturursa ikincisi okur.
async function ensureRun(link: GaPropertyLink): Promise<GaHealthRun> {
  try {
    return await prisma.gaHealthRun.upsert({
      where: { linkId: link.id },
      create: {
        linkId: link.id,
        workspaceId: link.workspaceId,
        projectId: link.projectId,
      },
      update: {},
    });
  } catch (error) {
    const existing = await prisma.gaHealthRun.findUnique({
      where: { linkId: link.id },
    });
    if (existing) return existing;
    throw error;
  }
}

async function claim(
  linkId: string,
  owner: string,
  now: Date,
  extra: { recheckRequestedAt?: Date } = {},
): Promise<boolean> {
  const claimed = await prisma.gaHealthRun.updateMany({
    where: {
      linkId,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + GA_HEALTH_LEASE_MS),
      leaseOwner: owner,
      ...extra,
    },
  });
  return claimed.count === 1;
}

async function releaseFailed(
  link: GaPropertyLink,
  owner: string,
  error: unknown,
): Promise<void> {
  const message = messageOf(error);
  console.error(`[ga-health] property ${link.propertyId} failed: ${message}`);
  await prisma.gaHealthRun
    .updateMany({
      where: { linkId: link.id, leaseOwner: owner },
      data: {
        leaseUntil: null,
        leaseOwner: null,
        lastError: message.slice(0, 300),
      },
    })
    .catch((releaseError: unknown) => {
      console.error(
        "[ga-health] lease could not be released:",
        messageOf(releaseError),
      );
    });
}

// Günlük temizlik: birincil bağı kalmamış projelerin açık GA4 uyarıları
// çözülür; 180 günden eski çözülmüş GA4 uyarıları silinir.
async function housekeeping(now: Date): Promise<void> {
  try {
    await SiteAlerts.purgeResolved("GA4", RESOLVED_KEEP_DAYS, now);
    const open = await prisma.adsAlert.groupBy({
      by: ["projectId"],
      where: { source: "GA4", status: { in: ["OPEN", "ACKED", "MUTED"] } },
    });
    const projectIds = open.map((row) => row.projectId);
    if (projectIds.length === 0) return;
    const primaries = await prisma.gaPropertyLink.findMany({
      where: { projectId: { in: projectIds }, isPrimary: true },
      select: { projectId: true },
    });
    const withPrimary = new Set(primaries.map((row) => row.projectId));
    await SiteAlerts.resolveForProjects(
      projectIds.filter((id) => !withPrimary.has(id)),
      "GA4",
      now,
    );
  } catch (error) {
    console.error("[ga-health] housekeeping failed:", messageOf(error));
  }
}

function dueKind(link: CandidateLink, now: Date): "full" | "realtime" | null {
  const timeZone = safeTimezone(link.timeZone);
  const today = dayKeyInTimezone(now, timeZone);
  const run = link.healthRun;
  const fingerprint = gaHealthFingerprint({
    today,
    lastDailyDate: link.lastDailyDate,
    lastMetadataAt: link.lastMetadataAt,
  });
  if (
    gaHealthDue({
      fingerprint,
      run: run
        ? {
            fingerprint: run.fingerprint,
            evaluatedAt: run.evaluatedAt,
            recheckRequestedAt: run.recheckRequestedAt,
          }
        : null,
      now,
    })
  ) {
    return "full";
  }
  // Yalnız-realtime yolu yoklayamayacak bağı her tick'te seçmesin.
  if (!gaLinkReachable(link, now)) return null;
  const state = parseGaRealtimeState(run?.realtime ?? null);
  return realtimeProbeDue(state, {
    today,
    hour: hourInTimezone(now, timeZone),
    now,
    expectedDailySessions: state?.expected ?? null,
  })
    ? "realtime"
    : null;
}

export const GaHealth = {
  // Tick adımı.
  async runDue(limit = 5, now: Date = new Date()): Promise<number> {
    if (!gaHealthEnabled()) return 0;
    await Heartbeat.beat(HEARTBEAT_KEY, now);
    if (
      gaGlobalWorkAllowedHere() &&
      (await claimPeriodic(HOUSEKEEPING_KEY, HOUSEKEEPING_EVERY_MS, now))
    ) {
      await housekeeping(now);
    }

    const candidates: CandidateLink[] = await prisma.gaPropertyLink.findMany({
      // GA-F8: ek mülkler de değerlendirilir (bayrak kapalıyken yalnız birincil).
      where: { ...gaEngineLinkWhere(), lastMetadataAt: { not: null } },
      include: { healthRun: true },
      orderBy: { healthRun: { evaluatedAt: { sort: "asc", nulls: "first" } } },
      take: CANDIDATES,
    });
    if (candidates.length === 0) {
      await Heartbeat.ok(HEARTBEAT_KEY, now);
      return 0;
    }
    const projects = await prisma.project.findMany({
      where: { id: { in: [...new Set(candidates.map((l) => l.projectId))] } },
      select: { id: true, status: true },
    });
    const statusById = new Map(projects.map((row) => [row.id, row.status]));

    let processed = 0;
    let siteUsed = false;
    for (const link of candidates) {
      if (processed >= limit) break;
      if (!gaSyncAllowedFor(link.projectId)) continue;
      const status = statusById.get(link.projectId);
      if (!status || status === "PAUSED" || status === "CLOSED") continue;
      const kind = dueKind(link, now);
      if (!kind) continue;

      const owner = `ga-health:${process.pid}:${now.getTime()}:${link.id}`;
      try {
        await ensureRun(link);
        if (!(await claim(link.id, owner, now))) continue;
      } catch (error) {
        console.error(
          `[ga-health] property ${link.propertyId} could not be claimed: ${messageOf(error)}`,
        );
        continue;
      }
      processed += 1;
      try {
        const run = await prisma.gaHealthRun.findUniqueOrThrow({
          where: { linkId: link.id },
        });
        if (kind === "full") {
          const evaluation = await evaluateGaLink(link, run, {
            now,
            force: false,
            allowSite: !siteUsed,
          });
          siteUsed ||= evaluation.siteScanned;
        } else {
          await evaluateGaRealtime(link, run, now);
        }
      } catch (error) {
        await releaseFailed(link, owner, error);
      }
    }
    await Heartbeat.ok(HEARTBEAT_KEY, now);
    return processed;
  },

  // "Check again" / "I fixed it": kilit ve recheckRequestedAt tek
  // updateMany'de (meşgul sonuç kullanıcıyı kısmaz). Değerlendirme satır içi,
  // zorlamalı (site taraması, bugünün PII yoklaması P1'de, uygunsa realtime).
  // Başarısız satır içi tur recheckRequestedAt > evaluatedAt bırakır; runDue
  // yeniden dener.
  async recheckNow(
    projectId: string,
    now: Date = new Date(),
  ): Promise<"rechecked" | "throttled" | "busy" | "failed" | "unavailable"> {
    if (!gaHealthEnabled() || !gaSyncAllowedFor(projectId)) {
      return "unavailable";
    }
    const link = await primaryGaLink(projectId);
    if (!link) return "unavailable";
    const existing = await ensureRun(link);
    if (recheckThrottledUntil(existing.recheckRequestedAt, now)) {
      return "throttled";
    }
    const owner = `ga-recheck:${process.pid}:${now.getTime()}:${link.id}`;
    if (!(await claim(link.id, owner, now, { recheckRequestedAt: now }))) {
      return "busy";
    }
    try {
      const run = await prisma.gaHealthRun.findUniqueOrThrow({
        where: { linkId: link.id },
      });
      await evaluateGaLink(link, run, { now, force: true, allowSite: true });
      return "rechecked";
    } catch (error) {
      // Gerçek hata eşzamanlılık mesajıyla karışmasın; releaseFailed
      // sayesinde runDue koşuyu kendiliğinden yeniden alır.
      await releaseFailed(link, owner, error);
      return "failed";
    }
  },
};
