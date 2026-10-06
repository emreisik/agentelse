import "server-only";

import type { AdsAlert, AdsSeverity, Prisma } from "@prisma/client";

import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import {
  isSiteAlertSource,
  SITE_ALERT_DEDUPE_PREFIX,
  type SiteAlertSource,
} from "@/lib/monitoring/site-alert-href";
import { siteAlertTelegramText } from "@/lib/monitoring/site-alert-text";
import { prisma } from "@/lib/prisma";
import { GaFlags } from "@/lib/website-analytics/flags";
import { notifyProjectTelegram } from "@/server/notifications/project-telegram-notifier";

export type { SiteAlertSource } from "@/lib/monitoring/site-alert-href";

// Site uyarıları (GK8; docs/measurement-health.md "Uyarılar"): GA4, Search
// Console ve SEO taramasının uyarıları ortak AdsAlert tablosunda `source`
// sütunuyla tutulur. Yeniden açılma / önem artışı / CAS anlamı AdsAlerts ile
// aynıdır; fark bildirimde: CRITICAL uyarı yalnız projenin kendi Telegram
// sohbetine (notifyProjectTelegram) sabit, rakamsız bir metinle gider, asla
// operatör sohbetine (sendTelegramMessage) gitmez (Limited Use). Loglar başlık
// ya da sayı taşımaz.

export type SiteAlertInput = {
  workspaceId: string;
  projectId: string;
  source: SiteAlertSource;
  kind: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  dedupeKey: string;
  title: string;
  detail?: string | null;
  data?: Prisma.InputJsonValue;
};

export type OpenSiteAlert = {
  id: string;
  source: SiteAlertSource;
  kind: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  title: string;
  detail: string | null;
  lastSeenAt: Date;
  dedupeKey: string;
};

// Yalnız açılış, yeniden açılış ya da önem artışında bildirilen türler: süresi
// dolan Google girişi Integrations'ta zaten "Needs reconnect" gösterir; her
// gün aynı mesaj gürültüdür.
export const SITE_ALERT_NO_RENOTIFY_KINDS: readonly string[] = ["GA_MH24"];

const RENOTIFY_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RANK: Record<AdsSeverity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };
const LIVE_STATUSES = ["OPEN", "ACKED", "MUTED"] as const;

// Canlı veritabanını paylaşan yerel süreç müşteriye mesaj göndermez
// (notifyProjectTelegram'ın kendisinde bu koruma yok).
function devNotificationsBlocked(): boolean {
  return (
    process.env.ALLOW_DEV_NOTIFICATIONS !== "true" &&
    metaWorkExcludedHere(process.env)
  );
}

async function projectTelegramConnected(projectId: string): Promise<boolean> {
  const credential = await prisma.integrationCredential.findFirst({
    where: { projectId, provider: "telegram", status: "ACTIVE" },
    select: { metadata: true },
  });
  const metadata = credential?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const chatId = (metadata as Record<string, unknown>).chatId;
  return typeof chatId === "string" && chatId.length > 0;
}

async function notifyIfDue(
  alert: AdsAlert,
  source: SiteAlertSource,
  now: Date,
): Promise<void> {
  if (alert.severity !== "CRITICAL" || alert.status !== "OPEN") return;
  if (devNotificationsBlocked()) return;
  const renotify = !SITE_ALERT_NO_RENOTIFY_KINDS.includes(alert.kind);
  const due =
    alert.notifiedAt === null ||
    (renotify && alert.notifiedAt.getTime() < now.getTime() - RENOTIFY_MS);
  if (!due) return;
  const hasTelegram = await projectTelegramConnected(alert.projectId);
  // CAS: deploy örtüşmesinde iki kopya aynı uyarıyı iki kez göndermez.
  const claimed = await prisma.adsAlert.updateMany({
    where: {
      id: alert.id,
      status: "OPEN",
      OR: [
        { notifiedAt: null },
        ...(renotify
          ? [{ notifiedAt: { lt: new Date(now.getTime() - RENOTIFY_MS) } }]
          : []),
      ],
    },
    data: {
      notifiedAt: now,
      notifyChannels: hasTelegram ? ["in_app", "telegram"] : ["in_app"],
    },
  });
  if (claimed.count === 0 || !hasTelegram) return;
  const project = await prisma.project.findUnique({
    where: { id: alert.projectId },
    select: { name: true },
  });
  await notifyProjectTelegram(
    alert.projectId,
    siteAlertTelegramText({
      source,
      kind: alert.kind,
      projectName: project?.name ?? "your project",
      projectId: alert.projectId,
      websitePage: GaFlags.websitePage(),
    }),
  );
}

function toOpenSiteAlert(row: AdsAlert): OpenSiteAlert | null {
  if (!isSiteAlertSource(row.source)) return null;
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    lastSeenAt: row.lastSeenAt,
    dedupeKey: row.dedupeKey,
  };
}

export const SiteAlerts = {
  async raise(input: SiteAlertInput, now: Date = new Date()): Promise<void> {
    if (!input.dedupeKey.startsWith(SITE_ALERT_DEDUPE_PREFIX[input.source])) {
      throw new Error(
        `Site alert dedupeKey does not match its source (${input.source})`,
      );
    }
    const where = {
      projectId_dedupeKey: {
        projectId: input.projectId,
        dedupeKey: input.dedupeKey,
      },
    };
    const existing = await prisma.adsAlert.findUnique({ where });
    const fields = {
      source: input.source,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      detail: input.detail ?? null,
      data: input.data ?? undefined,
      lastSeenAt: now,
    };
    let alert: AdsAlert;
    if (!existing) {
      // Eşzamanlı ilk kayıt yarışında upsert güncellemeye döner.
      alert = await prisma.adsAlert.upsert({
        where,
        create: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          dedupeKey: input.dedupeKey,
          firstSeenAt: now,
          ...fields,
        },
        update: { ...fields, occurrences: { increment: 1 } },
      });
    } else {
      const muted =
        existing.status === "MUTED" &&
        existing.mutedUntil !== null &&
        existing.mutedUntil.getTime() > now.getTime();
      const reopened =
        existing.status === "RESOLVED" ||
        (existing.status === "MUTED" && !muted);
      const escalated = RANK[input.severity] > RANK[existing.severity];
      alert = await prisma.adsAlert.update({
        where: { id: existing.id },
        data: {
          ...fields,
          ...(reopened
            ? {
                status: "OPEN",
                firstSeenAt: now,
                resolvedAt: null,
                mutedUntil: null,
                notifiedAt: null,
                occurrences: { increment: 1 },
              }
            : {}),
          // Önem artarsa (sessizde değilse) yeniden bildirilir.
          ...(escalated && !muted ? { notifiedAt: null, status: "OPEN" } : {}),
        },
      });
    }
    try {
      await notifyIfDue(alert, input.source, now);
    } catch (error) {
      console.error(
        `[site-alerts] ${input.source} notification failed:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
  },

  // Bu turda yeniden görülmeyen (koşulu düzelen) uyarılar kapanır. Yalnız
  // verilen kaynak ve türler içinde; başka kaynakların (Meta dahil) aynı adlı
  // satırlarına dokunmaz.
  async resolveMissing(
    input: {
      projectId: string;
      source: SiteAlertSource;
      kinds: string[];
      stillOpen: Set<string>;
    },
    now: Date = new Date(),
  ): Promise<number> {
    if (input.kinds.length === 0) return 0;
    const result = await prisma.adsAlert.updateMany({
      where: {
        projectId: input.projectId,
        source: input.source,
        kind: { in: [...input.kinds] },
        status: { in: [...LIVE_STATUSES] },
        dedupeKey: { notIn: [...input.stillOpen] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    return result.count;
  },

  // Açık uyarılar, önce en ciddi ve en yeni. Kaynak yoksa sorgu yok.
  async listOpen(
    projectId: string,
    sources: SiteAlertSource[],
    limit = 20,
  ): Promise<OpenSiteAlert[]> {
    if (sources.length === 0) return [];
    const rows = await prisma.adsAlert.findMany({
      where: {
        projectId,
        status: { in: ["OPEN", "ACKED"] },
        source: { in: [...sources] },
      },
      orderBy: { lastSeenAt: "desc" },
      take: limit * 2,
    });
    return rows
      .sort(
        (a, b) =>
          RANK[b.severity] - RANK[a.severity] ||
          b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
      )
      .slice(0, limit)
      .map(toOpenSiteAlert)
      .filter((row): row is OpenSiteAlert => row !== null);
  },

  // Yalnız site uyarıları susturulabilir (source boş olmayan satırlar); Meta
  // uyarıları kendi akışında. source verilirse yalnız o kaynağın satırı
  // (her yüzey yalnız kendi uyarısını sustursun).
  async mute(
    alertId: string,
    projectId: string,
    days = 7,
    source?: SiteAlertSource,
  ): Promise<void> {
    const now = new Date();
    await prisma.adsAlert.updateMany({
      where: { id: alertId, projectId, source: source ?? { not: null } },
      data: {
        status: "MUTED",
        mutedUntil: new Date(now.getTime() + days * DAY_MS),
      },
    });
  },

  // Her kaynak kendi saklama süresini yönetir (Meta saklaması yalnız
  // source: null).
  async purgeResolved(
    source: SiteAlertSource,
    olderThanDays = 180,
    now: Date = new Date(),
  ): Promise<number> {
    const result = await prisma.adsAlert.deleteMany({
      where: {
        source,
        status: "RESOLVED",
        resolvedAt: { lt: new Date(now.getTime() - olderThanDays * DAY_MS) },
      },
    });
    return result.count;
  },

  // Bağlantı kesilince: projenin bu kaynaktaki bütün uyarıları hemen silinir.
  async deleteForProjects(
    projectIds: string[],
    source: SiteAlertSource,
  ): Promise<number> {
    if (projectIds.length === 0) return 0;
    const result = await prisma.adsAlert.deleteMany({
      where: { projectId: { in: [...projectIds] }, source },
    });
    return result.count;
  },

  // Sahipsiz uyarılar (birincil bağı kalmayan projeler) kapanır.
  async resolveForProjects(
    projectIds: string[],
    source: SiteAlertSource,
    now: Date = new Date(),
  ): Promise<number> {
    if (projectIds.length === 0) return 0;
    const result = await prisma.adsAlert.updateMany({
      where: {
        projectId: { in: [...projectIds] },
        source,
        status: { in: [...LIVE_STATUSES] },
      },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    return result.count;
  },
};
