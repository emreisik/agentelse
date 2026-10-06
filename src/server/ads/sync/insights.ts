import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import {
  dailyRowFrom,
  sharedResultType,
  type DailyRow,
  type InsightLevel,
  type RawDailyInsight,
} from "@/lib/ads/insight-rows";
import { AdsFlags } from "@/lib/ads/flags";
import { addDays, BACKFILL_DAYS } from "@/lib/ads/sync-plan";
import { prisma } from "@/lib/prisma";
import {
  isTooMuchDataError,
  readDailyInsights,
} from "@/server/integrations/meta/sync-reads";

import type { SyncContext } from "./context";

// Günlük insights senkronu (docs/meta-ads-plan.md §3.2). Para kararları yalnız
// hesap satırından ve kampanya için kimlikle yapılan okumadan verilir:
// Meta, ARCHIVED / DELETED alt nesnelerin istatistiğini listelerde döndürmez,
// ebeveynin toplamında ve kimlikle okumada döndürür.

// Kimlikle okunan kampanya sayısı sınırı; aşılırsa liste okumasına düşülür.
const MAX_CAMPAIGN_READS = 40;
// Silinen Agentelse nesnelerinin kimlikle doldurulma sınırı (tur başına).
const MAX_DELETED_READS = 20;

type MirrorRow = {
  externalId: string;
  level: string;
  parentExternalId: string | null;
  campaignExternalId: string | null;
  resultActionType: string | null;
  projectId: string | null;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function upsertDailyRows(
  ctx: SyncContext,
  rows: (DailyRow & { projectId: string | null })[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const finalBefore = addDays(ctx.today, -BACKFILL_DAYS);
  let written = 0;
  for (const part of chunk(rows, 200)) {
    const values = part.map(
      (row) => Prisma.sql`(
        ${randomUUID()},
        ${ctx.account.id},
        ${row.projectId},
        ${row.level}::"AdsLevel",
        ${row.externalId},
        ${row.date}::date,
        ${BigInt(row.spendMinor)},
        ${row.impressions}::int,
        ${row.reach}::int,
        ${row.frequency}::double precision,
        ${row.clicks}::int,
        ${row.linkClicks}::int,
        ${row.landingPageViews}::int,
        ${row.results}::int,
        ${row.resultActionType},
        ${row.actionValuesMinor === null ? null : BigInt(row.actionValuesMinor)},
        ${row.actions ? JSON.stringify(row.actions) : null}::jsonb,
        ${row.video3s}::int,
        ${row.thruplays}::int,
        ${row.rankings ? JSON.stringify(row.rankings) : null}::jsonb,
        ${row.attributionSetting},
        ${row.date < finalBefore},
        ${ctx.now}
      )`,
    );
    written += await prisma.$executeRaw`
      INSERT INTO "AdsInsightDaily" (
        "id", "adsAccountId", "projectId", "level", "externalId", "date",
        "spendMinor", "impressions", "reach", "frequency", "clicks",
        "linkClicks", "landingPageViews", "results", "resultActionType",
        "actionValuesMinor", "actions", "video3s", "thruplays", "rankings",
        "attributionSetting", "isFinal", "fetchedAt"
      ) VALUES ${Prisma.join(values)}
      ON CONFLICT ("adsAccountId", "level", "externalId", "date") DO UPDATE SET
        "projectId" = EXCLUDED."projectId",
        "spendMinor" = EXCLUDED."spendMinor",
        "impressions" = EXCLUDED."impressions",
        "reach" = EXCLUDED."reach",
        "frequency" = EXCLUDED."frequency",
        "clicks" = EXCLUDED."clicks",
        "linkClicks" = EXCLUDED."linkClicks",
        "landingPageViews" = EXCLUDED."landingPageViews",
        "results" = EXCLUDED."results",
        "resultActionType" = EXCLUDED."resultActionType",
        "actionValuesMinor" = EXCLUDED."actionValuesMinor",
        "actions" = EXCLUDED."actions",
        "video3s" = EXCLUDED."video3s",
        "thruplays" = EXCLUDED."thruplays",
        "rankings" = EXCLUDED."rankings",
        "attributionSetting" = EXCLUDED."attributionSetting",
        "isFinal" = EXCLUDED."isFinal",
        "fetchedAt" = EXCLUDED."fetchedAt"`;
  }
  return written;
}

// Bir aralığın bütün düzeyleri. `children: false` yalnız hesap satırı.
export async function syncInsightsRange(
  ctx: SyncContext,
  range: { since: string; until: string },
): Promise<{ rows: number; spendMinor: number }> {
  const mirror: MirrorRow[] = await prisma.adsObject.findMany({
    where: { adsAccountId: ctx.account.id },
    select: {
      externalId: true,
      level: true,
      parentExternalId: true,
      campaignExternalId: true,
      resultActionType: true,
      projectId: true,
    },
  });
  const byId = new Map(mirror.map((row) => [row.externalId, row]));
  const adSets = mirror.filter((row) => row.level === "ADSET");
  const accountResultType = sharedResultType(adSets.map((row) => row.resultActionType));
  const campaignResultType = (campaignId: string) =>
    sharedResultType(
      adSets
        .filter((row) => row.campaignExternalId === campaignId)
        .map((row) => row.resultActionType),
    );
  const read = (level: "account" | "campaign" | "adset" | "ad", objectId?: string) =>
    readDailyInsights({
      adAccountId: ctx.externalId,
      accessToken: ctx.accessToken,
      level,
      since: range.since,
      until: range.until,
      objectId,
      includeArchived: level === "adset" || level === "ad",
    });
  const rows: (DailyRow & { projectId: string | null })[] = [];
  const push = (
    raws: RawDailyInsight[],
    level: InsightLevel,
    options: (raw: RawDailyInsight) => {
      resultActionType?: string | null;
      externalId?: string;
      projectId: string | null;
    },
  ) => {
    for (const raw of raws) {
      const opts = options(raw);
      const row = dailyRowFrom(raw, level, { currency: ctx.currency, ...opts });
      if (row) rows.push({ ...row, projectId: opts.projectId });
    }
  };

  // 1) Hesap: para kararlarının kaynağı.
  const accountRaw = await read("account");
  push(accountRaw, "ACCOUNT", () => ({
    externalId: ctx.externalId,
    resultActionType: accountResultType,
    projectId: ctx.primaryProjectId,
  }));
  const spendMinor = rows.reduce((sum, row) => sum + row.spendMinor, 0);
  const delivered = rows.some((row) => row.impressions > 0 || row.spendMinor > 0);

  if (delivered) {
    // 2) Ad set ve reklam listeleri (ARCHIVED dahil).
    const adSetRaw = await read("adset");
    push(adSetRaw, "ADSET", (raw) => {
      const object = raw.adset_id ? byId.get(raw.adset_id) : undefined;
      return {
        resultActionType: object?.resultActionType ?? null,
        projectId: object?.projectId ?? ctx.primaryProjectId,
      };
    });
    // F8: reklam listesi "çok fazla veri" derse async rapora düşülür
    // (hesap, ad set ve kampanya satırları yine bu turda yazılır).
    let adRaw: RawDailyInsight[];
    try {
      adRaw = await read("ad");
    } catch (error) {
      if (!AdsFlags.agency() || !isTooMuchDataError(error)) throw error;
      const { AsyncInsights } = await import("./async-insights");
      await AsyncInsights.enqueue(ctx, range);
      adRaw = [];
    }
    push(adRaw, "AD", (raw) => {
      const object = raw.ad_id ? byId.get(raw.ad_id) : undefined;
      const parent = raw.adset_id ? byId.get(raw.adset_id) : undefined;
      return {
        resultActionType:
          object?.resultActionType ?? parent?.resultActionType ?? null,
        projectId: object?.projectId ?? parent?.projectId ?? ctx.primaryProjectId,
      };
    });

    // 3) Kampanya toplamları kimlikle (silinen alt nesneler dahil).
    const campaignIds = new Set<string>();
    for (const raw of [...adSetRaw, ...adRaw]) {
      if (raw.campaign_id) campaignIds.add(raw.campaign_id);
    }
    if (campaignIds.size <= MAX_CAMPAIGN_READS) {
      for (const campaignId of campaignIds) {
        const object = byId.get(campaignId);
        push(await read("campaign", campaignId), "CAMPAIGN", () => ({
          externalId: campaignId,
          resultActionType: campaignResultType(campaignId),
          projectId: object?.projectId ?? ctx.primaryProjectId,
        }));
      }
    } else {
      console.warn(
        `[ads-sync] ${ctx.externalId}: ${campaignIds.size} campaigns delivered; reading the campaign list instead of each campaign`,
      );
      push(await read("campaign"), "CAMPAIGN", (raw) => {
        const object = raw.campaign_id ? byId.get(raw.campaign_id) : undefined;
        return {
          resultActionType: raw.campaign_id
            ? campaignResultType(raw.campaign_id)
            : null,
          projectId: object?.projectId ?? ctx.primaryProjectId,
        };
      });
    }
  }

  const written = await upsertDailyRows(ctx, rows);
  await markDelivery(ctx, rows);
  return { rows: written, spendMinor };
}

// Son teslimat günü (silinen nesnelerin 28 günlük kimlikle doldurulması ve
// pencere metrikleri için).
async function markDelivery(
  ctx: SyncContext,
  rows: DailyRow[],
): Promise<void> {
  const last = new Map<string, string>();
  for (const row of rows) {
    if (row.level === "ACCOUNT" || row.impressions <= 0) continue;
    const current = last.get(row.externalId);
    if (!current || row.date > current) last.set(row.externalId, row.date);
  }
  for (const [externalId, date] of last) {
    const at = new Date(`${date}T00:00:00.000Z`);
    await prisma.adsObject.updateMany({
      where: {
        adsAccountId: ctx.account.id,
        externalId,
        OR: [{ lastDeliveryAt: null }, { lastDeliveryAt: { lt: at } }],
      },
      data: { lastDeliveryAt: at },
    });
  }
}

// Silinen Agentelse nesneleri listelerde yoktur: son teslimattan sonraki 28
// gün boyunca kimlikle doldurulur.
export async function backfillDeletedObjects(
  ctx: SyncContext,
  range: { since: string; until: string },
): Promise<number> {
  const deleted = await prisma.adsObject.findMany({
    where: {
      adsAccountId: ctx.account.id,
      createdByAgentelse: true,
      effectiveStatus: "DELETED",
      level: { in: ["ADSET", "AD"] },
      lastDeliveryAt: {
        gte: new Date(ctx.now.getTime() - BACKFILL_DAYS * 24 * 60 * 60_000),
      },
    },
    take: MAX_DELETED_READS,
    orderBy: { lastDeliveryAt: "desc" },
  });
  const rows: (DailyRow & { projectId: string | null })[] = [];
  for (const object of deleted) {
    const level = object.level === "ADSET" ? "adset" : "ad";
    const raws = await readDailyInsights({
      adAccountId: ctx.externalId,
      accessToken: ctx.accessToken,
      level,
      since: range.since,
      until: range.until,
      objectId: object.externalId,
    });
    for (const raw of raws) {
      const row = dailyRowFrom(raw, object.level as InsightLevel, {
        currency: ctx.currency,
        externalId: object.externalId,
        resultActionType: object.resultActionType,
      });
      if (row) rows.push({ ...row, projectId: object.projectId });
    }
  }
  return upsertDailyRows(ctx, rows);
}
