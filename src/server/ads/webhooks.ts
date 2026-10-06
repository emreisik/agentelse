import "server-only";

import { Prisma, type AdsWebhookEvent } from "@prisma/client";

import { AdsFlags } from "@/lib/ads/flags";
import { mirrorFieldsFrom, type MetaRawObject } from "@/lib/ads/mirror";
import { nameWithoutTag } from "@/lib/ads/operation-tag";
import type { ParsedWebhookEvent } from "@/lib/ads/webhooks";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import { AdsGuard } from "@/server/ads/guard/watchdogs";
import type { SyncContext } from "@/server/ads/sync/context";
import { syncContextFor } from "@/server/ads/sync/context-for";
import { withMetaCallContext } from "@/server/integrations/meta/call-context";
import { readMirrorObjects } from "@/server/integrations/meta/sync-reads";

// Meta Ads webhook olay kutusu ve işleyicisi (docs/meta-ads-plan.md F7).
// Uç (api/webhooks/meta-ads) yalnız yazar ve hemen 200 döner; ajans tick'i
// 2 dk bekletip (aynı nesnenin art arda olayları tek okumada birleşir) her
// nesneyi hedefli okur, aynanın durum alanlarını tazeler ve bekçileri o
// hesap için hemen çalıştırır: ret ya da teslimat sorunu uyarısı yoklamayı
// beklemeden gelir. İzlenen alanlar (bütçe, durum) burada yazılmaz; drift
// kararı yapı senkronunda kalır. 5 denemeden sonra DEAD.

const DEBOUNCE_MS = 2 * 60_000;
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const OBJECT_FIELDS = new Set([
  "effective_status",
  "with_issues_ad_objects",
  "in_process_ad_objects",
]);

function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

export const AdsWebhookInbox = {
  // Yinelenen olay (Meta yeniden gönderir) dedupeKey ile düşer.
  async store(
    events: ParsedWebhookEvent[],
    now: Date = new Date(),
  ): Promise<number> {
    if (events.length === 0) return 0;
    const result = await prisma.adsWebhookEvent.createMany({
      data: events.map((event) => ({
        receivedAt: now,
        adAccountExternalId: event.adAccountExternalId,
        field: event.field,
        objectExternalId: event.objectExternalId,
        objectLevel: event.objectLevel,
        payload: event.payload as unknown as Prisma.InputJsonValue,
        dedupeKey: event.dedupeKey,
      })),
      skipDuplicates: true,
    });
    await prisma.adsAccount.updateMany({
      where: {
        externalId: {
          in: [...new Set(events.map((event) => event.adAccountExternalId))],
        },
      },
      data: { lastWebhookAt: now },
    });
    return result.count;
  },
};

async function claim(event: AdsWebhookEvent, now: Date): Promise<boolean> {
  const claimed = await prisma.adsWebhookEvent.updateMany({
    where: {
      id: event.id,
      status: "PENDING",
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: {
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      attempts: { increment: 1 },
    },
  });
  return claimed.count === 1;
}

async function finish(ids: string[], status: "DONE" | "SKIPPED", now: Date) {
  if (ids.length === 0) return;
  await prisma.adsWebhookEvent.updateMany({
    where: { id: { in: ids } },
    data: { status, processedAt: now, leaseUntil: null, lastError: null },
  });
}

async function retryLater(
  events: AdsWebhookEvent[],
  error: unknown,
  now: Date,
) {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 500);
  for (const event of events) {
    const attempts = event.attempts + 1;
    await prisma.adsWebhookEvent.update({
      where: { id: event.id },
      data:
        attempts >= MAX_ATTEMPTS
          ? {
              status: "DEAD",
              lastError: message,
              leaseUntil: null,
              processedAt: now,
            }
          : {
              lastError: message,
              // Geri çekilme: deneme × 2 dk.
              leaseUntil: new Date(now.getTime() + attempts * 2 * 60_000),
            },
    });
  }
}

// Nesnelerin durum alanlarını tek batch okumayla tazeler (drift'e konu
// alanlar yapı senkronunda kalır). Aynada olmayan yeni nesneyi bir sonraki
// yapı senkronu ekler.
async function refreshObjects(ctx: SyncContext, externalIds: string[]): Promise<void> {
  if (externalIds.length === 0) return;
  const rows = await prisma.adsObject.findMany({
    where: { adsAccountId: ctx.account.id, externalId: { in: externalIds } },
  });
  const targets = rows.flatMap((row) =>
    row.level === "ACCOUNT" ? [] : [{ row, level: row.level }],
  );
  if (targets.length === 0) return;
  const raws = await readMirrorObjects(
    targets.map((target) => ({ id: target.row.externalId, level: target.level })),
    ctx.accessToken,
  );
  for (const { row, level } of targets) {
    const raw = raws.get(row.externalId);
    if (!raw) continue;
    const fields = mirrorFieldsFrom(raw as unknown as MetaRawObject, level);
    await prisma.adsObject.update({
      where: { id: row.id },
      data: {
        effectiveStatus: fields.effectiveStatus,
        issues: json(fields.issues),
        reviewFeedback: json(fields.reviewFeedback),
        failedDeliveryChecks: json(fields.failedDeliveryChecks),
      },
    });
  }
}

async function raiseFatigue(
  ctx: SyncContext,
  externalId: string,
): Promise<void> {
  const ad = await prisma.adsObject.findFirst({
    where: { adsAccountId: ctx.account.id, externalId },
    select: { name: true, projectId: true },
  });
  const project =
    ctx.projects.find((row) => row.projectId === ad?.projectId) ??
    ctx.projects[0];
  if (!project) return;
  await AdsAlerts.raise(
    {
      workspaceId: project.workspaceId,
      projectId: project.projectId,
      adsAccountId: ctx.account.id,
      externalId,
      kind: "CREATIVE_FATIGUE",
      severity: "INFO",
      dedupeKey: `CREATIVE_FATIGUE:${externalId}`,
      title: `People have seen this ad a lot: ${ad ? nameWithoutTag(ad.name) : externalId}`,
      detail:
        "Meta says this creative is wearing out. A fresh picture or angle usually brings the cost back down.",
    },
    ctx.now,
  );
}

export const AdsWebhooks = {
  // Tick adımı.
  async processDue(limit = 50, now: Date = new Date()): Promise<number> {
    if (!AdsFlags.webhooks() || !AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    const due = await prisma.adsWebhookEvent.findMany({
      where: {
        status: "PENDING",
        receivedAt: { lt: new Date(now.getTime() - DEBOUNCE_MS) },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      orderBy: { receivedAt: "asc" },
      take: limit,
    });
    const byAccount = new Map<string, AdsWebhookEvent[]>();
    for (const event of due) {
      if (!(await claim(event, now))) continue;
      const list = byAccount.get(event.adAccountExternalId) ?? [];
      list.push(event);
      byAccount.set(event.adAccountExternalId, list);
    }
    let processed = 0;
    for (const [externalId, events] of byAccount) {
      try {
        processed += await this.processAccount(externalId, events, now);
      } catch (error) {
        console.error(
          `[ads-webhooks] ${externalId} failed:`,
          error instanceof Error ? error.message : error,
        );
        await retryLater(events, error, now);
      }
    }
    return processed;
  },

  async processAccount(
    externalId: string,
    events: AdsWebhookEvent[],
    now: Date,
  ): Promise<number> {
    const accounts = await prisma.adsAccount.findMany({
      where: { platform: "META", externalId },
      include: {
        projects: {
          where: { selected: true },
          select: { projectId: true, brandId: true },
        },
      },
    });
    const ids = events.map((event) => event.id);
    const relevant = events.filter(
      (event) =>
        OBJECT_FIELDS.has(event.field) || event.field === "creative_fatigue",
    );
    let handled = false;
    for (const account of accounts) {
      const ctx = await syncContextFor(account, now);
      if (!ctx) continue;
      handled = true;
      const objectIds = [
        ...new Set(
          relevant
            .filter(
              (event) =>
                OBJECT_FIELDS.has(event.field) && event.objectExternalId,
            )
            .map((event) => event.objectExternalId!),
        ),
      ];
      const fatigued = [
        ...new Set(
          relevant
            .filter(
              (event) =>
                event.field === "creative_fatigue" && event.objectExternalId,
            )
            .map((event) => event.objectExternalId!),
        ),
      ];
      await withMetaCallContext(
        { account: externalId, lane: "P2_BACKGROUND", callSite: "ads.webhook" },
        async () => {
          await refreshObjects(ctx, objectIds);
        },
      );
      for (const adId of fatigued) await raiseFatigue(ctx, adId);
      if (objectIds.length > 0) await AdsGuard.evaluateAccount(ctx);
    }
    await finish(ids, handled ? "DONE" : "SKIPPED", now);
    return ids.length;
  },
};
