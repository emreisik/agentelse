import "server-only";

import type { GaConfigChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { dayKeyInTimezone } from "@/lib/timezone";
import { safeTimezone } from "@/lib/website-analytics/days";
import {
  gaFixIsAlpha,
  GA_FIX_CATALOG,
} from "@/lib/website-analytics/fixes/catalog";
import { gaEditStartHref } from "@/lib/website-analytics/fixes/consent-copy";
import {
  GA_FIX_ERROR_MESSAGES,
  GA_FIX_STATUS_LABEL,
  GA_FIX_STATUS_LABEL_SWITCHED_OFF,
} from "@/lib/website-analytics/fixes/copy";
import {
  gaFixAlphaEnabled,
  gaFixesEnabledFor,
} from "@/lib/website-analytics/fixes/flags";
import { computeFixOffers } from "@/lib/website-analytics/fixes/offers";
import { planUndo } from "@/lib/website-analytics/fixes/plan";
import {
  GA_FIX_ERROR_CODES,
  GA_FIX_KINDS,
  GA_FIX_STATUSES,
  type GaFixErrorCode,
  type GaFixKind,
  type GaFixSnapshot,
  type GaFixSource,
  type GaFixStatus,
} from "@/lib/website-analytics/fixes/types";
import type {
  GaFixChangeView,
  GaFixesView,
  GaOutsideChangeView,
} from "@/lib/website-analytics/fixes/view-types";
import { gaHealthEnabled } from "@/lib/website-analytics/health/flags";
import type {
  GaCheckEvidence,
  GaCheckKey,
  GaCheckStatus,
} from "@/lib/website-analytics/health/types";
import { SiteAlerts } from "@/server/monitoring/site-alerts";
import { primaryGaLink } from "@/server/website-analytics/store";

import { loadGaEditAccess } from "./edit-grant";

// GA-F7 Website paneli okuyucusu (docs/website-fixes.md "Arayüz"):
// "Changes Agentelse made" bölümü, kontrol kartlarındaki "Fix it for me"
// önerileri ve Agentelse dışı değişiklik uyarıları. GA_FIXES kapalıyken (ya
// da dev izin listesi dışında) sorgusuz null. Çıktı serileştirilebilir
// (ISO metin); mülk adı ve Google'dan gelen sayı taşımaz.

const VIEW_CHANGES = 30;
const MANAGER_ROLES: readonly string[] = ["OWNER", "ADMIN"];
const OUTSIDE_KINDS = {
  GA_CHG_KEY_EVENT_REMOVED: "KEY_EVENT_REMOVED",
  GA_CHG_RETENTION_SHORTENED: "RETENTION_SHORTENED",
} as const;
const RESOLVED_STATUSES: readonly GaFixStatus[] = [
  "VERIFIED",
  "FAILED",
  "UNDONE",
  "REJECTED",
  "EXPIRED",
];

function kindOf(value: string): GaFixKind | null {
  return GA_FIX_KINDS.find((kind) => kind === value) ?? null;
}

function statusOf(value: string): GaFixStatus | null {
  return GA_FIX_STATUSES.find((status) => status === value) ?? null;
}

function sourceOf(value: string): GaFixSource {
  return value === "GUIDE" || value === "PANEL" || value === "AUTO"
    ? value
    : "API";
}

// Onay satırının kararı değişiklik satırından önce görünür (sohbetten verilen
// ret hemen "Rejected" gösterir).
function derivedStatus(
  row: GaConfigChange,
  approvalStatus: string | undefined,
): GaFixStatus | null {
  const status = statusOf(row.status);
  if (status !== "PROPOSED") return status;
  if (
    approvalStatus === "REJECTED" ||
    approvalStatus === "REVISION_REQUESTED"
  ) {
    return "REJECTED";
  }
  if (approvalStatus === "CANCELLED" || approvalStatus === "EXPIRED") {
    return "EXPIRED";
  }
  return status;
}

// Saklanan hata satırından yalnız tanınan kod ve sabit metin okunur. Hata
// FAILED satırda ya da başarısız geri almanın bıraktığı VERIFIED satırda
// (error.undo) gösterilir; başka durumda eski hata gizlenir.
function errorView(
  value: unknown,
  status: GaFixStatus,
): { code: GaFixErrorCode; message: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { code, undo } = value as { code?: unknown; undo?: unknown };
  if (status !== "FAILED" && !(status === "VERIFIED" && undo === true)) {
    return null;
  }
  const known = GA_FIX_ERROR_CODES.find((item) => item === code);
  return known ? { code: known, message: GA_FIX_ERROR_MESSAGES[known] } : null;
}

function keyEventNamesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) =>
      typeof item === "object" && item !== null
        ? (item as { eventName?: unknown }).eventName
        : undefined,
    )
    .filter((name): name is string => typeof name === "string");
}

function resolvedAtOf(
  row: GaConfigChange,
  status: GaFixStatus,
  approvalReviewedAt: Date | null,
): string | null {
  if (!RESOLVED_STATUSES.includes(status)) return null;
  const at =
    status === "VERIFIED"
      ? row.verifiedAt
      : status === "UNDONE"
        ? row.rolledBackAt
        : status === "FAILED"
          ? row.failedAt
          : (approvalReviewedAt ?? row.updatedAt);
  return (at ?? row.updatedAt).toISOString();
}

export async function loadGaFixesView(input: {
  projectId: string;
  userId: string;
  checks?: {
    key: GaCheckKey;
    status: GaCheckStatus;
    evidence: GaCheckEvidence;
  }[];
  now?: Date;
}): Promise<GaFixesView | null> {
  const { projectId, userId } = input;
  if (!gaFixesEnabledFor(projectId)) return null;
  const link = await primaryGaLink(projectId);
  if (!link) return null;
  const now = input.now ?? new Date();

  const [access, membership, rows, alerts] = await Promise.all([
    loadGaEditAccess(projectId),
    prisma.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: link.workspaceId, userId },
      },
      select: { role: true },
    }),
    prisma.gaConfigChange.findMany({
      where: { linkId: link.id },
      orderBy: { createdAt: "desc" },
      take: VIEW_CHANGES,
    }),
    SiteAlerts.listOpen(projectId, ["GA4"], 100),
  ]);
  const canManage = MANAGER_ROLES.includes(membership?.role ?? "");

  const approvalIds = rows
    .filter((row) => row.status === "PROPOSED" && row.approvalId)
    .map((row) => row.approvalId as string);
  const approvals =
    approvalIds.length > 0
      ? await prisma.approval.findMany({
          where: { id: { in: approvalIds } },
          select: { id: true, status: true, reviewedAt: true },
        })
      : [];
  const approvalById = new Map(approvals.map((row) => [row.id, row]));
  const alphaEnabled = gaFixAlphaEnabled();

  const changes: GaFixChangeView[] = [];
  const offerChanges: {
    id: string;
    kind: GaFixKind;
    status: GaFixStatus;
    dedupeKey: string;
    noop: boolean;
  }[] = [];
  for (const row of rows) {
    const kind = kindOf(row.kind);
    const stored = statusOf(row.status);
    if (!kind || !stored) continue;
    const approval = row.approvalId
      ? approvalById.get(row.approvalId)
      : undefined;
    const status = derivedStatus(row, approval?.status) ?? stored;
    const catalog = GA_FIX_CATALOG[kind];
    const switchedOff =
      status === "APPROVED" && gaFixIsAlpha(kind) && !alphaEnabled;
    changes.push({
      id: row.id,
      kind,
      title: row.title,
      status,
      statusLabel: switchedOff
        ? GA_FIX_STATUS_LABEL_SWITCHED_OFF
        : GA_FIX_STATUS_LABEL[status],
      source: sourceOf(row.source),
      createdAt: row.createdAt.toISOString(),
      resolvedAt: resolvedAtOf(row, status, approval?.reviewedAt ?? null),
      expiresAt: status === "PROPOSED" ? row.expiresAt.toISOString() : null,
      approvalId: row.approvalId,
      canDecide:
        stored === "PROPOSED" && approval?.status === "PENDING" && canManage,
      // Geri alma OWNER/ADMIN işidir; düğme başkasına gösterilmez.
      // Anlık görüntüler geri alınamayı da dışlayabilir (örn. silinemeyen Google tanımlı olaylar).
      canUndo:
        status === "VERIFIED" &&
        !row.noop &&
        catalog.undoable &&
        canManage &&
        planUndo({
          kind,
          noop: row.noop,
          before: row.before as unknown as GaFixSnapshot | null,
          after: row.after as unknown as GaFixSnapshot | null,
          resourceName: row.resourceName,
        }).ok,
      undoWarning: catalog.undoWarning,
      noop: row.noop,
      switchedOff,
      error: errorView(row.error, status),
    });
    offerChanges.push({
      id: row.id,
      kind,
      status,
      dedupeKey: row.dedupeKey,
      noop: row.noop,
    });
  }

  const outside: GaOutsideChangeView[] = [];
  const linkPrefix = `ga4:${link.id}:CHG:`;
  for (const alert of alerts) {
    if (!alert.kind.startsWith("GA_CHG_")) continue;
    if (!alert.dedupeKey.startsWith(linkPrefix)) continue;
    const kind = OUTSIDE_KINDS[alert.kind as keyof typeof OUTSIDE_KINDS];
    if (!kind) continue;
    outside.push({
      alertId: alert.id,
      kind,
      title: alert.title,
      detail: alert.detail,
      lastSeenAt: alert.lastSeenAt.toISOString(),
    });
  }

  const offers = computeFixOffers({
    enabled: true,
    alphaEnabled,
    editGranted: access?.granted === true,
    checks: input.checks ?? [],
    link: {
      keyEventNames: keyEventNamesOf(link.keyEvents),
      dataRetention: link.dataRetention,
      streamId: link.streamId,
      serviceLevel: link.serviceLevel,
    },
    changes: offerChanges,
  });

  return {
    editAccess: access?.granted ? "granted" : "not_granted",
    canManage,
    alphaEnabled,
    canMuteOutside: gaHealthEnabled(),
    upgradeHref: gaEditStartHref(projectId),
    changes,
    outside,
    offers,
    annotationDefaultDay: dayKeyInTimezone(now, safeTimezone(link.timeZone)),
  };
}

// Son `days` günde açılan değişiklikler (raporlar ve brief için): yalnız tür,
// durum ve zaman. GA_FIXES kapalıyken sorgusuz boş.
export async function listRecentGaConfigChanges(
  projectId: string,
  days: number,
  now: Date = new Date(),
): Promise<{ kind: GaFixKind; status: GaFixStatus; at: string }[]> {
  if (!gaFixesEnabledFor(projectId)) return [];
  const since = new Date(now.getTime() - days * 24 * 3_600_000);
  const rows = await prisma.gaConfigChange.findMany({
    where: { projectId, createdAt: { gte: since } },
    select: { kind: true, status: true, createdAt: true, verifiedAt: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const result: { kind: GaFixKind; status: GaFixStatus; at: string }[] = [];
  for (const row of rows) {
    const kind = kindOf(row.kind);
    const status = statusOf(row.status);
    if (!kind || !status) continue;
    result.push({
      kind,
      status,
      at: (row.verifiedAt ?? row.createdAt).toISOString(),
    });
  }
  return result;
}
