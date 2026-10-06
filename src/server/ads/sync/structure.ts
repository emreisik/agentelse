import "server-only";

import { randomUUID } from "node:crypto";

import { Prisma, type AdsLevel, type AdsObject } from "@prisma/client";

import {
  driftSeverity,
  isDelivering,
  mirrorFieldsFrom,
  trackedChanges,
  trackedHash,
  type MetaRawObject,
  type MirrorFields,
  type MirrorLevel,
} from "@/lib/ads/mirror";
import { nameWithoutTag, tagOfName } from "@/lib/ads/operation-tag";
import { resultActionTypeForGoal } from "@/lib/ads/results";
import { prisma } from "@/lib/prisma";
import { AdsAlerts } from "@/server/ads/guard/alerts";
import {
  listAccountStructure,
  readObjectStatus,
  readWindowStats,
} from "@/server/integrations/meta/sync-reads";

import type { SyncContext } from "./context";
import { describeDrift, explainedByOperation } from "./drift";

// Yapı senkronu (docs/meta-ads-plan.md §3.2): kampanya / ad set / reklam
// listeleri aynaya yazılır; listede görünmeyen nesne arşivlenmiş ya da
// silinmiştir (goneAt), Agentelse'in kurduğu nesne kimlikle doğrulanır;
// izlenen alan değişikliği bizim yazmamızla açıklanmıyorsa drift uyarısı
// açılır. Pencere metrikleri (7/28 gün erişim ve sıklık) burada okunur.

function big(value: number | null): bigint | null {
  return value === null ? null : BigInt(value);
}

// Boş değer SQL NULL olarak yazılır (sorun düzelince sütun temizlenir).
function json(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

function dataFor(fields: MirrorFields) {
  return {
    level: fields.level as AdsLevel,
    parentExternalId: fields.parentExternalId,
    campaignExternalId: fields.campaignExternalId,
    name: fields.name,
    objective: fields.objective,
    optimizationGoal: fields.optimizationGoal,
    billingEvent: fields.billingEvent,
    bidStrategy: fields.bidStrategy,
    destinationType: fields.destinationType,
    configuredStatus: fields.configuredStatus,
    effectiveStatus: fields.effectiveStatus,
    dailyBudgetMinor: big(fields.dailyBudgetMinor),
    lifetimeBudgetMinor: big(fields.lifetimeBudgetMinor),
    spendCapMinor: big(fields.spendCapMinor),
    budgetRemainingMinor: big(fields.budgetRemainingMinor),
    startTime: fields.startTime,
    endTime: fields.endTime,
    learningStatus: fields.learningStatus,
    learningConversions: fields.learningConversions,
    lastSigEditAt: fields.lastSigEditAt,
    issues: json(fields.issues),
    reviewFeedback: json(fields.reviewFeedback),
    failedDeliveryChecks: json(fields.failedDeliveryChecks),
    advantageState: fields.advantageState,
    creativeExternalId: fields.creativeExternalId,
    metaUpdatedAt: fields.metaUpdatedAt,
    fieldsHash: trackedHash(fields),
    goneAt: null,
  };
}

function trackedFromRow(row: AdsObject) {
  return {
    configuredStatus: row.configuredStatus,
    dailyBudgetMinor:
      row.dailyBudgetMinor === null ? null : Number(row.dailyBudgetMinor),
    lifetimeBudgetMinor:
      row.lifetimeBudgetMinor === null ? null : Number(row.lifetimeBudgetMinor),
    endTime: row.endTime,
    spendCapMinor: row.spendCapMinor === null ? null : Number(row.spendCapMinor),
    bidStrategy: row.bidStrategy,
    // Hedefleme özeti satırda ayrı tutulmaz: fieldsHash farkı yeterli, alan
    // ayrımı için yeni değerle aynı kabul edilir (aşağıda).
    targetingHash: null,
    creativeExternalId: row.creativeExternalId,
  };
}

export type StructureResult = {
  objects: number;
  delivering: number;
  truncated: boolean;
};

export async function syncStructure(ctx: SyncContext): Promise<StructureResult> {
  const listed = await listAccountStructure(ctx.externalId, ctx.accessToken);
  const existing = await prisma.adsObject.findMany({
    where: { adsAccountId: ctx.account.id },
  });
  const byId = new Map(existing.map((row) => [row.externalId, row]));

  // Etiket → niyet günlüğü: proje, lansman ve "Agentelse kurdu" bilgisi.
  const all: { raw: MetaRawObject; level: MirrorLevel }[] = [
    ...listed.campaigns.map((raw) => ({ raw: raw as MetaRawObject, level: "CAMPAIGN" as const })),
    ...listed.adSets.map((raw) => ({ raw: raw as MetaRawObject, level: "ADSET" as const })),
    ...listed.ads.map((raw) => ({ raw: raw as MetaRawObject, level: "AD" as const })),
  ];
  const tags = [
    ...new Set(
      all
        .map(({ raw }) => tagOfName(raw.name))
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  const ops = tags.length
    ? await prisma.adsOperation.findMany({
        where: { tag: { in: tags } },
        select: {
          tag: true,
          projectId: true,
          launchId: true,
          resultExternalId: true,
        },
      })
    : [];
  const opByTag = new Map(ops.map((op) => [op.tag, op]));

  // Ad set'in sonuç türü reklamlara da yazılır (yedek sonuç eşlemesi).
  const adSetResultType = new Map<string, string | null>();
  for (const raw of listed.adSets) {
    const promoted = raw.promoted_object as
      | { custom_event_type?: string }
      | undefined;
    adSetResultType.set(
      raw.id,
      resultActionTypeForGoal(raw.optimization_goal, promoted?.custom_event_type),
    );
  }

  const creates: Prisma.AdsObjectCreateManyInput[] = [];
  const seen: string[] = [];
  let delivering = 0;

  for (const { raw, level } of all) {
    const fields = mirrorFieldsFrom(raw, level);
    const tag = tagOfName(raw.name);
    const op = tag ? opByTag.get(tag) : undefined;
    const ours = Boolean(op && op.resultExternalId === raw.id);
    const resultActionType =
      level === "ADSET"
        ? (adSetResultType.get(raw.id) ?? null)
        : level === "AD" && fields.parentExternalId
          ? (adSetResultType.get(fields.parentExternalId) ?? null)
          : null;
    const projectId = ours ? op!.projectId : ctx.primaryProjectId;
    if (level === "ADSET" && isDelivering(fields, ctx.now)) delivering += 1;
    seen.push(raw.id);

    const previous = byId.get(raw.id);
    const data = {
      ...dataFor(fields),
      name: fields.name,
      resultActionType,
      projectId,
      createdByAgentelse: ours,
      launchId: ours ? (op!.launchId ?? null) : null,
    };
    if (!previous) {
      creates.push({
        id: randomUUID(),
        adsAccountId: ctx.account.id,
        externalId: raw.id,
        lastSeenAt: ctx.now,
        ...data,
        issues: (fields.issues ?? undefined) as Prisma.InputJsonValue | undefined,
        reviewFeedback: (fields.reviewFeedback ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        failedDeliveryChecks: (fields.failedDeliveryChecks ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
      });
      continue;
    }

    const changed =
      previous.fieldsHash !== data.fieldsHash ||
      previous.effectiveStatus !== data.effectiveStatus ||
      previous.name !== data.name ||
      previous.learningStatus !== data.learningStatus ||
      previous.goneAt !== null ||
      previous.projectId !== data.projectId ||
      previous.resultActionType !== data.resultActionType ||
      JSON.stringify(previous.issues ?? null) !== JSON.stringify(fields.issues ?? null) ||
      JSON.stringify(previous.reviewFeedback ?? null) !==
        JSON.stringify(fields.reviewFeedback ?? null) ||
      Number(previous.budgetRemainingMinor ?? -1) !==
        (fields.budgetRemainingMinor ?? -1);
    if (!changed) continue;

    let driftAt: Date | undefined;
    if (previous.fieldsHash && previous.fieldsHash !== data.fieldsHash) {
      const before = trackedFromRow(previous);
      const changes = trackedChanges(
        { ...before, targetingHash: fields.targetingHash },
        fields,
      );
      // Yalnız hedefleme değiştiyse alan ayrımı yok: hash farkı yeterli.
      const effective =
        changes.length > 0
          ? changes
          : [{ field: "targetingHash" as const, from: "previous", to: "current" }];
      const since = previous.lastSeenAt ?? previous.updatedAt;
      if (!(await explainedByOperation(raw.id, since))) {
        driftAt = ctx.now;
        await raiseDrift(ctx, previous, fields, effective, projectId);
      }
    }
    await prisma.adsObject.update({
      where: { id: previous.id },
      data: { ...data, ...(driftAt ? { driftAt } : {}) },
    });
  }

  if (creates.length > 0) {
    await prisma.adsObject.createMany({ data: creates, skipDuplicates: true });
  }
  if (seen.length > 0) {
    await prisma.adsObject.updateMany({
      where: { adsAccountId: ctx.account.id, externalId: { in: seen } },
      data: { lastSeenAt: ctx.now },
    });
  }

  // Listede görünmeyenler (kırpılmış listede bu adım atlanır: eksik liste
  // yanlış "silindi" üretmesin).
  if (!listed.truncated) {
    const seenSet = new Set(seen);
    const missing = existing.filter(
      (row) => !seenSet.has(row.externalId) && row.goneAt === null,
    );
    for (const row of missing) {
      let status: string | null = row.effectiveStatus;
      if (row.createdByAgentelse) {
        const read = await readObjectStatus(row.externalId, ctx.accessToken);
        status = read ? (read.effective_status ?? "ARCHIVED") : "DELETED";
        if (read && status !== "ARCHIVED" && status !== "DELETED") {
          // Hâlâ var ama listede yok (süzgeç farkı): yalnız durumu tazele.
          await prisma.adsObject.update({
            where: { id: row.id },
            data: { effectiveStatus: status, lastSeenAt: ctx.now },
          });
          continue;
        }
      }
      await prisma.adsObject.update({
        where: { id: row.id },
        data: {
          goneAt: ctx.now,
          effectiveStatus: status === "DELETED" ? "DELETED" : "ARCHIVED",
        },
      });
    }
  }

  await syncWindowStats(ctx, delivering > 0);
  await prisma.adsAccount.update({
    where: { id: ctx.account.id },
    data: { lastStructureAt: ctx.now },
  });
  return { objects: seen.length, delivering, truncated: listed.truncated };
}

async function raiseDrift(
  ctx: SyncContext,
  previous: AdsObject,
  fields: MirrorFields,
  changes: Parameters<typeof driftSeverity>[0],
  projectId: string | null,
): Promise<void> {
  const severity = driftSeverity(changes);
  const targets = projectId
    ? ctx.projects.filter((project) => project.projectId === projectId)
    : ctx.projects;
  for (const project of targets.length ? targets : ctx.projects) {
    await AdsAlerts.raise(
      {
        workspaceId: project.workspaceId,
        projectId: project.projectId,
        adsAccountId: ctx.account.id,
        externalId: previous.externalId,
        kind: "DRIFT_DETECTED",
        severity,
        dedupeKey: `drift:${previous.externalId}`,
        title: `Changed in Ads Manager: ${nameWithoutTag(fields.name)}`,
        detail:
          describeDrift(changes, ctx.currency) +
          (severity === "WARN"
            ? " This goes beyond the approved plan. Update the plan or change it back in Ads Manager."
            : ""),
        data: { level: fields.level, changes },
      },
      ctx.now,
    );
  }
}

// 7 ve 28 günlük tekil kişi metrikleri: yalnız teslimat süren ya da son 28
// günde teslimat almış nesne varken (4 okuma).
async function syncWindowStats(
  ctx: SyncContext,
  deliveringNow: boolean,
): Promise<void> {
  const recent = deliveringNow
    ? 1
    : await prisma.adsObject.count({
        where: {
          adsAccountId: ctx.account.id,
          lastDeliveryAt: {
            gte: new Date(ctx.now.getTime() - 28 * 24 * 60 * 60_000),
          },
        },
      });
  if (recent === 0) return;
  type Stat = { reach?: string; frequency?: string; impressions?: string };
  const stats = new Map<string, { d7?: Stat; d28?: Stat }>();
  for (const level of ["adset", "ad"] as const) {
    for (const preset of ["last_7d", "last_28d"] as const) {
      const rows = await readWindowStats({
        adAccountId: ctx.externalId,
        accessToken: ctx.accessToken,
        level,
        preset,
      });
      for (const row of rows) {
        const id = level === "adset" ? row.adset_id : row.ad_id;
        if (!id) continue;
        const entry = stats.get(id) ?? {};
        entry[preset === "last_7d" ? "d7" : "d28"] = {
          reach: row.reach,
          frequency: row.frequency,
          impressions: row.impressions,
        };
        stats.set(id, entry);
      }
    }
  }
  for (const [externalId, entry] of stats) {
    const windowStats = {
      d7: normalizeStat(entry.d7),
      d28: normalizeStat(entry.d28),
      at: ctx.now.toISOString(),
    };
    await prisma.adsObject.updateMany({
      where: { adsAccountId: ctx.account.id, externalId },
      data: { windowStats },
    });
  }
}

function normalizeStat(
  stat: { reach?: string; frequency?: string; impressions?: string } | undefined,
) {
  if (!stat) return null;
  const number = (value: string | undefined) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    reach: Math.round(number(stat.reach)),
    frequency: number(stat.frequency),
    impressions: Math.round(number(stat.impressions)),
  };
}
