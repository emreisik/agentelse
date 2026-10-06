import "server-only";

import type { AdsAlert, AdsSeverity, Prisma } from "@prisma/client";

import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import { sendTelegramMessage } from "@/server/notifications/telegram.service";

// Tekilleştirilmiş reklam uyarıları (docs/meta-ads-plan.md §3.6 Uyarı
// yönlendirme). (proje, dedupeKey) başına tek satır: koşul tekrar ederse aynı
// satır yeniden açılır ve occurrences artar, düzelince RESOLVED olur. LLM
// puanlamasından geçmez. CRITICAL Telegram'a gider; mesaj Meta'dan okunan
// veriyi (harcama, kampanya adı) taşımaz (K8).

export type AlertInput = {
  workspaceId: string;
  projectId: string;
  adsAccountId?: string | null;
  externalId?: string | null;
  kind: string;
  severity: AdsSeverity;
  dedupeKey: string;
  title: string;
  detail?: string | null;
  data?: Record<string, unknown>;
};

const RENOTIFY_MS = 24 * 60 * 60_000;
const RANK: Record<AdsSeverity, number> = { INFO: 0, WARN: 1, CRITICAL: 2 };

// Telegram metni: yalnız Agentelse'in kendi verisi.
export function telegramTextFor(alert: {
  kind: string;
  projectName: string;
  projectId: string;
}): string {
  const what = TELEGRAM_KIND_TEXT[alert.kind] ?? "needs your attention";
  const link = appUrl(`/projects/${alert.projectId}/ads`).toString();
  return `Ads alert for ${escapeHtml(alert.projectName)}: ${what}. Open Agentelse: ${link}`;
}

const TELEGRAM_KIND_TEXT: Record<string, string> = {
  RUNAWAY_SPEND: "spending above plan",
  ACCOUNT_BLOCKED: "the ad account can't run ads",
  PAYMENT_ISSUE: "the ad account has a payment issue",
  SPEND_CAP_REACHED: "the ad account reached its spending limit",
  TOKEN_INVALID: "the Meta Ads connection stopped working",
  ALL_ADS_REJECTED: "all ads were rejected",
  ENVELOPE_REACHED: "a campaign reached its approved budget",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function notifyIfDue(alert: AdsAlert, now: Date): Promise<void> {
  if (alert.severity !== "CRITICAL" || alert.status !== "OPEN") return;
  // CAS: deploy örtüşmesinde iki kopya aynı uyarıyı iki kez göndermez.
  const claimed = await prisma.adsAlert.updateMany({
    where: {
      id: alert.id,
      OR: [
        { notifiedAt: null },
        { notifiedAt: { lt: new Date(now.getTime() - RENOTIFY_MS) } },
      ],
    },
    data: { notifiedAt: now, notifyChannels: ["in_app", "telegram"] },
  });
  if (claimed.count !== 1) return;
  const project = await prisma.project.findUnique({
    where: { id: alert.projectId },
    select: { name: true },
  });
  await sendTelegramMessage(
    telegramTextFor({
      kind: alert.kind,
      projectName: project?.name ?? "your project",
      projectId: alert.projectId,
    }),
  );
}

export const AdsAlerts = {
  async raise(input: AlertInput, now: Date = new Date()): Promise<AdsAlert> {
    const existing = await prisma.adsAlert.findUnique({
      where: {
        projectId_dedupeKey: {
          projectId: input.projectId,
          dedupeKey: input.dedupeKey,
        },
      },
    });
    const fields = {
      adsAccountId: input.adsAccountId ?? null,
      externalId: input.externalId ?? null,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      detail: input.detail ?? null,
      data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
      lastSeenAt: now,
    };
    let alert: AdsAlert;
    if (!existing) {
      alert = await prisma.adsAlert.upsert({
        where: {
          projectId_dedupeKey: {
            projectId: input.projectId,
            dedupeKey: input.dedupeKey,
          },
        },
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
      const reopened = existing.status === "RESOLVED" || (existing.status === "MUTED" && !muted);
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
          // Önem artarsa yeniden bildirilir.
          ...(escalated && !muted ? { notifiedAt: null, status: "OPEN" } : {}),
        },
      });
    }
    try {
      await notifyIfDue(alert, now);
    } catch (error) {
      console.error(
        "[ads-alerts] notification failed:",
        error instanceof Error ? error.message : error,
      );
    }
    return alert;
  },

  // Bu turda yeniden görülmeyen (koşulu düzelen) uyarılar kapanır. Yalnız
  // verilen türler ve (varsa) hesap kapsamı içinde.
  async resolveMissing(
    input: {
      projectId: string;
      kinds: readonly string[];
      stillOpen: ReadonlySet<string>;
      adsAccountId?: string;
    },
    now: Date = new Date(),
  ): Promise<number> {
    const open = await prisma.adsAlert.findMany({
      where: {
        projectId: input.projectId,
        kind: { in: [...input.kinds] },
        status: { in: ["OPEN", "ACKED", "MUTED"] },
        ...(input.adsAccountId ? { adsAccountId: input.adsAccountId } : {}),
      },
      select: { id: true, dedupeKey: true },
    });
    const ids = open
      .filter((row) => !input.stillOpen.has(row.dedupeKey))
      .map((row) => row.id);
    if (ids.length === 0) return 0;
    const result = await prisma.adsAlert.updateMany({
      where: { id: { in: ids } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
    return result.count;
  },

  async resolve(projectId: string, dedupeKey: string, now: Date = new Date()) {
    await prisma.adsAlert.updateMany({
      where: { projectId, dedupeKey, status: { not: "RESOLVED" } },
      data: { status: "RESOLVED", resolvedAt: now },
    });
  },

  async mute(alertId: string, projectId: string, days = 7, now: Date = new Date()) {
    return prisma.adsAlert.updateMany({
      where: { id: alertId, projectId },
      data: {
        status: "MUTED",
        mutedUntil: new Date(now.getTime() + days * 24 * 60 * 60_000),
      },
    });
  },

  async acknowledge(alertId: string, projectId: string) {
    return prisma.adsAlert.updateMany({
      where: { id: alertId, projectId, status: "OPEN" },
      data: { status: "ACKED" },
    });
  },

  // Açık uyarılar, önce en ciddi ve en yeni.
  async listOpen(projectId: string, limit = 20): Promise<AdsAlert[]> {
    const rows = await prisma.adsAlert.findMany({
      where: { projectId, status: { in: ["OPEN", "ACKED"] } },
      orderBy: { lastSeenAt: "desc" },
      take: limit * 2,
    });
    return rows
      .sort(
        (a, b) =>
          RANK[b.severity] - RANK[a.severity] ||
          b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
      )
      .slice(0, limit);
  },
};
