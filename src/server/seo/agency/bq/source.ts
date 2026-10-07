import "server-only";

import { Prisma, type GscBqSource, type GscSiteLink } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { gscBigQueryActiveFor } from "@/lib/seo/agency/flags";
import {
  BQ_MESSAGE,
  BQ_SOURCE_ERROR_TEXT,
  isBqSourceErrorCode,
  type BqSourceErrorCode,
} from "@/lib/seo/agency/bq/copy";
import {
  currentUsageMonth,
  rolloverUsage,
  type BqUsage,
} from "@/lib/seo/agency/bq/cost";
import {
  DEFAULT_MAX_BYTES_PER_QUERY,
  DEFAULT_MONTHLY_BYTES,
  hardMaxBytes,
  hardMonthlyBytes,
} from "@/lib/seo/agency/bq/limits";
import type { BqBadge } from "@/lib/seo/agency/types";
import {
  addWeeks,
  dateToDayKey,
  lastCompleteWeekStart,
  weekEndOf,
} from "@/lib/seo/dates";
import {
  bigQueryClient,
  isValidDatasetId,
  isValidGcpProjectId,
} from "@/server/integrations/google/bigquery";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// BigQuery kaynağının ayarı ve okuma görünümü (docs/search-agency.md).
// SAHİPLİK GÜVENLİK SINIRIDIR: servis hesabı tüm müşteriler için tek
// hesaptır; kaydetme, açma ve her senkron turu GscSiteLink.permissionLevel =
// siteOwner şartını arar (saklanan değer, Google çağrısı yok).

export type BqSourceView = {
  linkId: string;
  siteUrl: string;
  status: BqBadge;
  // Servis hesabı anahtarı var (mock kipte her zaman)
  configured: boolean;
  isOwner: boolean;
  serviceAccountEmail: string | null;
  bqProjectId: string | null;
  dataset: string | null;
  location: string | null;
  exportStart: string | null;
  exportedThrough: string | null;
  importAll: boolean;
  maxBytesPerQuery: number;
  monthlyBudgetBytes: number;
  usedBytesMonth: number;
  queriesMonth: number;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastError: BqSourceErrorCode | null;
  errorText: string | null;
  imported: { weeks: number; months: number; lastWeek: string | null };
  completeWeeks: number;
  reconcile: {
    days: number;
    clicksDiffPct: number | null;
    impressionsDiffPct: number | null;
    checkedAt: string;
  } | null;
};

const VERIFY_VALID_MS = 24 * 3_600_000;
const BADGES: readonly BqBadge[] = [
  "DRAFT",
  "VERIFIED",
  "ACTIVE",
  "PAUSED",
  "ERROR",
  "BUDGET",
];

function badgeOf(status: string): BqBadge {
  return (BADGES as readonly string[]).includes(status)
    ? (status as BqBadge)
    : "DRAFT";
}

// Projenin bu kipteki birincil ya da ikincil bağı (başka mod ya da proje: null).
export async function findBqLink(
  projectId: string,
  linkId: string,
): Promise<GscSiteLink | null> {
  return prisma.gscSiteLink.findFirst({
    where: {
      id: linkId,
      projectId,
      isMock: gscMockMode(),
      OR: [{ isPrimary: true }, { isSecondary: true }],
    },
  });
}

// Bu sağlık durumlarında saklanan sahiplik bilgisine güvenilmez: Google erişimi
// kesilmiş, izin düşmüş ya da mülk kaybolmuştur.
const UNTRUSTED_HEALTH: ReadonlySet<string> = new Set([
  "AUTH",
  "NEEDS_PERMISSION",
  "ACCESS_LOST",
  "GONE",
  "API_DISABLED",
]);

// Sahiplik kanıtı yalnız saklanan permissionLevel değildir: o değeri syncMetadata
// tazeler ve bunun için ETKİN bir kimlik bilgisi gerekir. Kullanıcı Google
// erişimini geri aldıysa (RISC, süre dolumu) değer eski kalır; bu yüzden bağın
// sağlığı ve kimlik bilgisinin durumu da aranır. Mock kipte kimlik bilgisi yok.
export async function bqOwnershipHolds(
  link: Pick<
    GscSiteLink,
    "permissionLevel" | "health" | "isMock" | "credentialId"
  >,
): Promise<boolean> {
  if (link.permissionLevel !== "siteOwner") return false;
  if (UNTRUSTED_HEALTH.has(link.health)) return false;
  if (link.isMock) return true;
  const credential = await prisma.integrationCredential.findUnique({
    where: { id: link.credentialId },
    select: { status: true },
  });
  return credential?.status === "ACTIVE";
}

export async function findBqSource(
  link: Pick<GscSiteLink, "projectId" | "siteUrl">,
): Promise<GscBqSource | null> {
  const source = await prisma.gscBqSource.findUnique({
    where: {
      projectId_siteUrl: { projectId: link.projectId, siteUrl: link.siteUrl },
    },
  });
  return source && source.isMock === gscMockMode() ? source : null;
}

export function usageOf(source: GscBqSource, now: Date): BqUsage {
  return rolloverUsage(
    {
      usageMonth: source.usageMonth,
      bytesBilledMonth: Number(source.bytesBilledMonth),
      queriesMonth: source.queriesMonth,
    },
    now,
  );
}

// Faturalanan baytları kaynağın aylık sayacına ekler. Artış atomiktir (iki
// süreç aynı anda yazsa da kaybolmaz); ay dönmüşse önce sayaç sıfırlanır.
export async function addBqUsage(
  sourceId: string,
  billedBytes: number,
  queries: number,
  now: Date,
): Promise<void> {
  const month = currentUsageMonth(now);
  await prisma.gscBqSource.updateMany({
    where: {
      id: sourceId,
      OR: [{ usageMonth: null }, { usageMonth: { not: month } }],
    },
    data: { usageMonth: month, bytesBilledMonth: BigInt(0), queriesMonth: 0 },
  });
  await prisma.gscBqSource.update({
    where: { id: sourceId },
    data: {
      bytesBilledMonth: { increment: BigInt(Math.max(0, Math.round(billedBytes))) },
      queriesMonth: { increment: queries },
    },
  });
}

function parseReconcile(value: unknown): BqSourceView["reconcile"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const pct = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : null;
  if (typeof raw.checkedAt !== "string" || typeof raw.days !== "number") {
    return null;
  }
  return {
    days: raw.days,
    clicksDiffPct: pct(raw.clicksDiffPct),
    impressionsDiffPct: pct(raw.impressionsDiffPct),
    checkedAt: raw.checkedAt,
  };
}

function completeWeeksIn(
  start: string | null,
  through: string | null,
): number {
  if (!start || !through || start > through) return 0;
  // Penceredeki tam haftalar: son tam haftadan geriye, başlangıca kadar.
  let count = 0;
  let week = lastCompleteWeekStart(through);
  while (week >= start && weekEndOf(week) <= through && count < 1_000) {
    count += 1;
    week = addWeeks(week, -1);
  }
  return count;
}

export async function loadBqSourceView(
  projectId: string,
  linkId: string,
): Promise<BqSourceView | null> {
  if (!gscBigQueryActiveFor(projectId)) return null;
  const link = await findBqLink(projectId, linkId);
  if (!link) return null;
  const [source, grouped] = await Promise.all([
    findBqSource(link),
    prisma.gscPeriodFetch.groupBy({
      by: ["grain"],
      where: { linkId, source: "BQ", key: "query" },
      _count: { _all: true },
      _max: { periodStart: true },
    }),
  ]);
  const client = bigQueryClient();
  const weeks = grouped.find((row) => row.grain === "WEEK");
  const months = grouped.find((row) => row.grain === "MONTH");
  const lastError =
    source && isBqSourceErrorCode(source.lastError) ? source.lastError : null;
  return {
    linkId,
    siteUrl: link.siteUrl,
    status: source ? badgeOf(source.status) : "OFF",
    configured: client.configured(),
    isOwner: link.permissionLevel === "siteOwner",
    serviceAccountEmail: client.serviceAccountEmail(),
    bqProjectId: source?.bqProjectId ?? null,
    dataset: source?.dataset ?? null,
    location: source?.location ?? null,
    exportStart: source?.exportStart ?? null,
    exportedThrough: source?.exportedThrough ?? null,
    importAll: source?.importAll ?? false,
    maxBytesPerQuery: source
      ? Number(source.maxBytesPerQuery)
      : DEFAULT_MAX_BYTES_PER_QUERY,
    monthlyBudgetBytes: source
      ? Number(source.monthlyBudgetBytes)
      : DEFAULT_MONTHLY_BYTES,
    // Ay dönmüşse sayaç henüz sıfırlanmamış olsa da bu ay için sıfır gösterilir.
    usedBytesMonth: source
      ? usageOf(source, new Date()).bytesBilledMonth
      : 0,
    queriesMonth: source ? usageOf(source, new Date()).queriesMonth : 0,
    lastVerifiedAt: source?.lastVerifiedAt?.toISOString() ?? null,
    lastSyncAt: source?.lastSyncAt?.toISOString() ?? null,
    lastError,
    errorText: lastError ? BQ_SOURCE_ERROR_TEXT[lastError] : null,
    imported: {
      weeks: weeks?._count._all ?? 0,
      months: months?._count._all ?? 0,
      lastWeek: weeks?._max.periodStart
        ? dateToDayKey(weeks._max.periodStart)
        : null,
    },
    completeWeeks: completeWeeksIn(
      source?.exportStart ?? null,
      source?.exportedThrough ?? null,
    ),
    reconcile: parseReconcile(source?.reconcile),
  };
}

type Result = { ok: true } | { ok: false; message: string };

function clampBytes(value: number, ceiling: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return Math.min(fallback, ceiling);
  return Math.min(Math.floor(value), ceiling);
}

export async function recordBqAudit(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  action: string;
  sourceId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await AuditLogRepository.record({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorType: "USER",
    actorId: input.userId,
    action: input.action,
    entityType: "GscBqSource",
    entityId: input.sourceId,
    metadata: input.metadata,
  }).catch((error: unknown) => {
    console.error(
      "[gsc-bigquery] audit could not be written:",
      error instanceof Error ? error.name : error,
    );
  });
}

export async function saveBqSource(input: {
  projectId: string;
  linkId: string;
  bqProjectId: string;
  dataset: string;
  maxBytesPerQuery: number;
  monthlyBudgetBytes: number;
  importAll: boolean;
  userId: string;
}): Promise<Result> {
  if (!gscBigQueryActiveFor(input.projectId)) {
    return { ok: false, message: BQ_MESSAGE.notAllowed };
  }
  const link = await findBqLink(input.projectId, input.linkId);
  if (!link) return { ok: false, message: BQ_MESSAGE.noSite };
  // Sahiplik kapısı: mülk sahibi değilse hiçbir şey yazılmaz.
  if (link.permissionLevel !== "siteOwner") {
    return { ok: false, message: BQ_SOURCE_ERROR_TEXT.NOT_OWNER };
  }
  const bqProjectId = input.bqProjectId.trim();
  const dataset = input.dataset.trim();
  if (!isValidGcpProjectId(bqProjectId)) {
    return { ok: false, message: BQ_MESSAGE.invalidProject };
  }
  if (!isValidDatasetId(dataset)) {
    return { ok: false, message: BQ_MESSAGE.invalidDataset };
  }
  const maxBytesPerQuery = clampBytes(
    input.maxBytesPerQuery,
    hardMaxBytes(),
    DEFAULT_MAX_BYTES_PER_QUERY,
  );
  const monthlyBudgetBytes = clampBytes(
    input.monthlyBudgetBytes,
    hardMonthlyBytes(),
    DEFAULT_MONTHLY_BYTES,
  );

  const existing = await prisma.gscBqSource.findUnique({
    where: {
      projectId_siteUrl: { projectId: link.projectId, siteUrl: link.siteUrl },
    },
  });
  if (existing && existing.isMock !== link.isMock) {
    return { ok: false, message: BQ_MESSAGE.failed };
  }

  const config = {
    bqProjectId,
    dataset,
    importAll: input.importAll,
    maxBytesPerQuery: BigInt(maxBytesPerQuery),
    monthlyBudgetBytes: BigInt(monthlyBudgetBytes),
  };
  let sourceId: string;
  if (!existing) {
    const created = await prisma.gscBqSource.create({
      data: {
        workspaceId: link.workspaceId,
        projectId: link.projectId,
        siteUrl: link.siteUrl,
        isMock: link.isMock,
        status: "DRAFT",
        createdByUserId: input.userId,
        ...config,
      },
    });
    sourceId = created.id;
  } else {
    sourceId = existing.id;
    const moved =
      existing.bqProjectId !== bqProjectId || existing.dataset !== dataset;
    await prisma.gscBqSource.update({
      where: { id: existing.id },
      data: moved
        ? {
            ...config,
            // Başka veri kümesi: önceki doğrulamadan türeyen her şey sıfırlanır.
            status: "DRAFT",
            location: null,
            bqSiteUrl: null,
            exportStart: null,
            exportedThrough: null,
            coverageCheckedAt: null,
            lastVerifiedAt: null,
            lastError: null,
            consecutiveFailures: 0,
            nextRunAt: null,
            reconcile: Prisma.DbNull,
          }
        : config,
    });
  }
  await recordBqAudit({
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    userId: input.userId,
    action: "gsc_bigquery.configured",
    sourceId,
    metadata: { linkId: link.id, importAll: input.importAll },
  });
  return { ok: true };
}

const ON_FROM: readonly string[] = ["VERIFIED", "PAUSED", "BUDGET", "ACTIVE"];

export async function setBqSourceState(input: {
  projectId: string;
  linkId: string;
  state: "ON" | "PAUSE" | "REMOVE";
  userId: string;
  now?: Date;
}): Promise<Result> {
  if (!gscBigQueryActiveFor(input.projectId)) {
    return { ok: false, message: BQ_MESSAGE.notAllowed };
  }
  const now = input.now ?? new Date();
  const link = await findBqLink(input.projectId, input.linkId);
  if (!link) return { ok: false, message: BQ_MESSAGE.noSite };
  const source = await findBqSource(link);
  if (!source) return { ok: false, message: BQ_MESSAGE.notSetUp };
  const base = {
    workspaceId: link.workspaceId,
    projectId: link.projectId,
    userId: input.userId,
    sourceId: source.id,
    metadata: { linkId: link.id },
  };

  if (input.state === "REMOVE") {
    // Yalnız kaynak satırı silinir; içe aktarılan ambar satırları kalır.
    await prisma.gscBqSource.delete({ where: { id: source.id } });
    await recordBqAudit({ ...base, action: "gsc_bigquery.removed" });
    return { ok: true };
  }

  if (input.state === "PAUSE") {
    await prisma.gscBqSource.update({
      where: { id: source.id },
      data: { status: "PAUSED", nextRunAt: null },
    });
    await recordBqAudit({ ...base, action: "gsc_bigquery.paused" });
    return { ok: true };
  }

  // ON: sahip olmak + son 24 saatte geçen doğrulama.
  if (!(await bqOwnershipHolds(link))) {
    return { ok: false, message: BQ_SOURCE_ERROR_TEXT.NOT_OWNER };
  }
  const verifiedAt = source.lastVerifiedAt?.getTime() ?? 0;
  if (
    !ON_FROM.includes(source.status) ||
    now.getTime() - verifiedAt > VERIFY_VALID_MS
  ) {
    return { ok: false, message: BQ_MESSAGE.notVerified };
  }
  if (source.status === "BUDGET") {
    const usage = usageOf(source, now);
    const budget = Math.min(
      Number(source.monthlyBudgetBytes),
      hardMonthlyBytes(),
    );
    if (usage.bytesBilledMonth >= budget) {
      return { ok: false, message: BQ_MESSAGE.budgetUsed };
    }
  }
  await prisma.gscBqSource.update({
    where: { id: source.id },
    data: {
      status: "ACTIVE",
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
    },
  });
  await recordBqAudit({ ...base, action: "gsc_bigquery.enabled" });
  return { ok: true };
}
