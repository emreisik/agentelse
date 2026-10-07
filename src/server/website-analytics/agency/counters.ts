import "server-only";

import type { ShareCounters } from "@/lib/seo/agency/types";
import { gscAgencyOn } from "@/lib/seo/agency/flags";
import { reportShareOn } from "@/lib/report-share/flags";
import { prisma } from "@/lib/prisma";
import {
  gaAgencyEnabled,
  googleRiscEnabled,
} from "@/lib/website-analytics/agency/flags";
import { addDays, dateToDayKey } from "@/lib/website-analytics/days";
import {
  GoogleKeyRotation,
  type GoogleKeyStatus,
} from "@/server/integrations/google/key-rotation";
import { googleKeyRingConfigured } from "@/server/integrations/google/secret";
import { loadShareCounters } from "@/server/report-share/counters";

// /health "Google Analytics agency" sayaçları (GA-F8): yalnız sayılar
// (Limited Use). Mülk kimliği, ad, adres, e-posta ya da müşteri rakamı burada
// hiç yer almaz. Üç özellik de kapalıyken null döner ve hiçbir sorgu atılmaz.

export type GaAgencyCounters = {
  links: {
    main: number;
    extra: number;
    workspacesWithExtras: number;
    extraHealthNotOk: number;
    extraStale72h: number;
  };
  // SC-F9'un paylaşım sayaçları, YALNIZ Search agency kapalıyken (açıkken SC-F9'un
  // kartı aynı sayıları gösterir; iki kartta tekrar etmesin).
  shares: ShareCounters | null;
  bigQuery: {
    pending: number;
    ok: number;
    error: number;
    bytesThisMonth: number;
  };
  funnels: { defined: number; ran24h: number; failed: number };
  risc: {
    received24h: number;
    applied24h: number;
    received30d: number;
    recheck30d: number;
    pending: number;
  };
  keys: GoogleKeyStatus | null;
};

const DAY_MS = 86_400_000;

// Bir sayaç okunamazsa 0: tek sorgunun hatası bütün /health sayfasını düşürmez.
function safe<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  return read().catch(() => fallback);
}

export async function loadGaAgencyCounters(
  now: Date = new Date(),
): Promise<GaAgencyCounters | null> {
  if (
    !gaAgencyEnabled() &&
    !googleRiscEnabled() &&
    !googleKeyRingConfigured()
  ) {
    return null;
  }
  const since24h = new Date(now.getTime() - DAY_MS);
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  const staleCutoff = addDays(dateToDayKey(now), -3);
  const staleCreated = new Date(now.getTime() - 3 * DAY_MS);
  const month = now.toISOString().slice(0, 7);

  const [
    main,
    extra,
    extraWorkspaces,
    extraNotOk,
    extraStale,
    bigQueryByStatus,
    bigQueryBytes,
    funnelsDefined,
    funnelsRan,
    funnelsFailed,
    riscReceived24h,
    riscApplied24h,
    riscReceived30d,
    riscRecheck30d,
    riscPending,
    shares,
    keys,
  ] = await Promise.all([
    safe(() => prisma.gaPropertyLink.count({ where: { isPrimary: true } }), 0),
    safe(() => prisma.gaPropertyLink.count({ where: { isSecondary: true } }), 0),
    safe(
      async () =>
        (
          await prisma.gaPropertyLink.groupBy({
            by: ["workspaceId"],
            where: { isSecondary: true },
          })
        ).length,
      0,
    ),
    safe(
      () =>
        prisma.gaPropertyLink.count({
          where: { isSecondary: true, health: { not: "OK" } },
        }),
      0,
    ),
    // Veri 72 saatten eski ya da hiç gelmemiş ve bağ da 72 saatten eski.
    safe(
      () =>
        prisma.gaPropertyLink.count({
          where: {
            isSecondary: true,
            OR: [
              { lastDailyDate: { lt: staleCutoff } },
              { lastDailyDate: null, createdAt: { lt: staleCreated } },
            ],
          },
        }),
      0,
    ),
    safe(
      () =>
        prisma.gaBigQuerySource.groupBy({
          by: ["status"],
          _count: { _all: true },
        }),
      [],
    ),
    safe(
      async () =>
        Number(
          (
            await prisma.gaBigQuerySource.aggregate({
              where: { usageMonth: month },
              _sum: { usageBytes: true },
            })
          )._sum.usageBytes ?? 0,
        ),
      0,
    ),
    safe(() => prisma.gaFunnel.count(), 0),
    safe(
      () => prisma.gaFunnel.count({ where: { lastRunAt: { gte: since24h } } }),
      0,
    ),
    safe(
      () => prisma.gaFunnel.count({ where: { lastError: { not: null } } }),
      0,
    ),
    safe(
      () =>
        prisma.googleRiscEvent.count({
          where: { receivedAt: { gte: since24h } },
        }),
      0,
    ),
    safe(
      () =>
        prisma.googleRiscEvent.count({
          where: { receivedAt: { gte: since24h }, outcome: "APPLIED" },
        }),
      0,
    ),
    safe(
      () =>
        prisma.googleRiscEvent.count({
          where: { receivedAt: { gte: since30d } },
        }),
      0,
    ),
    safe(
      () =>
        prisma.googleRiscEvent.count({
          where: { receivedAt: { gte: since30d }, outcome: "RECHECK" },
        }),
      0,
    ),
    safe(
      () => prisma.googleRiscEvent.count({ where: { outcome: "PENDING" } }),
      0,
    ),
    // Search agency açıkken SC-F9'un /health kartı aynı sayıları gösterir.
    !gscAgencyOn() && reportShareOn()
      ? safe(() => loadShareCounters(now), null)
      : Promise.resolve(null),
    safe(() => GoogleKeyRotation.status(), null),
  ]);

  const statusCount = (status: string) =>
    bigQueryByStatus.find((row) => row.status === status)?._count._all ?? 0;

  return {
    links: {
      main,
      extra,
      workspacesWithExtras: extraWorkspaces,
      extraHealthNotOk: extraNotOk,
      extraStale72h: extraStale,
    },
    shares,
    bigQuery: {
      pending: statusCount("PENDING"),
      ok: statusCount("OK"),
      error: statusCount("ERROR"),
      bytesThisMonth: bigQueryBytes,
    },
    funnels: {
      defined: funnelsDefined,
      ran24h: funnelsRan,
      failed: funnelsFailed,
    },
    risc: {
      received24h: riscReceived24h,
      applied24h: riscApplied24h,
      received30d: riscReceived30d,
      recheck30d: riscRecheck30d,
      pending: riscPending,
    },
    keys,
  };
}
