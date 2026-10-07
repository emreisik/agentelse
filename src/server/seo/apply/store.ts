import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { applyMockMode } from "@/lib/seo/apply/flags";
import { approvalRowsFor } from "@/lib/seo/apply/approval-details";
import {
  changeUndoWarning,
  SEO_CHANGE_ERROR_MESSAGES,
  SEO_CHANGE_STATUS_LABEL,
} from "@/lib/seo/apply/copy";
import { isUndoable } from "@/lib/seo/apply/lifecycle";
import {
  SEO_CHANGE_ERROR_CODES,
  SEO_CHANGE_KINDS,
  SEO_CHANGE_STATUSES,
  type SeoChangeErrorCode,
  type SeoChangeKind,
  type SeoChangeParams,
  type SeoChangeSource,
  type SeoChangeStatus,
  type WpSnapshot,
} from "@/lib/seo/apply/types";
import type { SeoChangeView } from "@/lib/seo/apply/view-types";
import { pathOf } from "@/lib/seo/crawl-url";

// SeoChange satırlarının okuyucuları ve görünüm dönüştürücüsü. Saklı JSON'a
// güvenilmez: her okuyucu hoşgörülüdür ve hiçbiri fırlatmaz.

const SOURCES: readonly SeoChangeSource[] = ["ARTICLE", "ACTION", "DRAFT"];
const INDEX_NOW_STATES = ["PENDING", "SENT", "SKIPPED", "FAILED"] as const;
const DEFAULT_LIST = 30;
const LIST_MAX = 100;

function oneOf<T extends string>(
  value: string,
  allowed: readonly T[],
): T | null {
  return allowed.find((item) => item === value) ?? null;
}

export function statusOf(row: Pick<SeoChange, "status">): SeoChangeStatus {
  return oneOf(row.status, SEO_CHANGE_STATUSES) ?? "FAILED";
}

export function kindOf(row: Pick<SeoChange, "kind">): SeoChangeKind {
  return oneOf(row.kind, SEO_CHANGE_KINDS) ?? "TITLE_META";
}

export function paramsOfChange(
  row: Pick<SeoChange, "params">,
): SeoChangeParams | null {
  const params = row.params;
  if (typeof params !== "object" || params === null) return null;
  const kind = (params as { kind?: unknown }).kind;
  return typeof kind === "string" &&
    (SEO_CHANGE_KINDS as readonly string[]).includes(kind)
    ? (params as SeoChangeParams)
    : null;
}

export function snapshotOfJson(value: unknown): WpSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof record[key] === "string" ? (record[key] as string) : null;
  const num = (key: string): number | null =>
    typeof record[key] === "number" && Number.isFinite(record[key])
      ? (record[key] as number)
      : null;
  const type =
    record.type === "post" || record.type === "page" ? record.type : null;
  return {
    exists: record.exists === true,
    type,
    id: num("id"),
    status: text("status"),
    link: text("link"),
    modified: text("modified"),
    title: text("title"),
    excerpt: text("excerpt"),
    seoTitle: text("seoTitle"),
    seoDescription: text("seoDescription"),
    contentHash: text("contentHash"),
    contentWords: num("contentWords"),
    contentRaw: text("contentRaw"),
  };
}

function errorOf(
  value: unknown,
): { code: SeoChangeErrorCode; message: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { code, message } = value as { code?: unknown; message?: unknown };
  const known = (SEO_CHANGE_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as SeoChangeErrorCode)
    : null;
  if (!known) return null;
  // Saklı metin her zaman sabit metindir; bozuksa koddan türetilir.
  return {
    code: known,
    message:
      typeof message === "string" && message
        ? message
        : SEO_CHANGE_ERROR_MESSAGES[known],
  };
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Önizleme satırları saklı parametrelerden ve önceki durumdan kurulur; onay
// kartıyla aynı yazım (approvalRowsFor). Süre satırı yalnız bekleyen onayda anlamlıdır.
function previewOf(
  row: SeoChange,
  status: SeoChangeStatus,
): { label: string; value: string }[] {
  const params = paramsOfChange(row);
  if (!params) return [];
  const before = snapshotOfJson(row.before);
  const kind = params.kind;
  const url =
    params.kind === "TITLE_META" || params.kind === "INTERNAL_LINKS"
      ? params.url
      : (row.liveUrl ?? row.targetUrl);
  const host = hostOf(url) ?? hostOf(row.targetUrl) ?? "WordPress";
  const rows = approvalRowsFor({
    kind,
    host,
    path:
      params.kind === "TITLE_META" || params.kind === "INTERNAL_LINKS"
        ? pathOf(params.url)
        : null,
    before: {
      title: before ? (before.seoTitle ?? before.title) : null,
      description: before?.seoDescription ?? null,
    },
    after: {
      title:
        params.kind === "TITLE_META" || params.kind === "PUBLISH_ARTICLE"
          ? params.title
          : null,
      description: params.kind === "TITLE_META" ? params.metaDescription : null,
      links:
        params.kind === "INTERNAL_LINKS"
          ? params.links.map((link) => ({
              anchor: link.anchor,
              toPath: pathOf(link.toUrl),
            }))
          : undefined,
    },
    titleVia: null,
    undoText: changeUndoWarning(kind) ?? "You can undo this for 90 days.",
  });
  return status === "PROPOSED"
    ? rows
    : rows.filter((item) => item.label !== "Expires");
}

function resolvedAtOf(row: SeoChange, status: SeoChangeStatus): Date | null {
  switch (status) {
    case "VERIFIED":
      return row.verifiedAt;
    case "FAILED":
      return row.failedAt;
    case "UNDONE":
      return row.rolledBackAt;
    case "REJECTED":
    case "EXPIRED":
      return row.updatedAt;
    default:
      return null;
  }
}

// PROPOSED satırın görünen durumu Approval satırından türer: sohbette verilen
// ret ya da süre dolumu, tick'i beklemeden hemen yansır.
function displayStatusOf(
  status: SeoChangeStatus,
  approvalStatus: string | null,
): SeoChangeStatus {
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

export function changeViewOf(
  row: SeoChange,
  extra: {
    approvalStatus: string | null;
    viewerIsManager: boolean;
    hasOpenLive: boolean;
  },
  now: Date,
): SeoChangeView {
  const status = statusOf(row);
  const kind = kindOf(row);
  const after = snapshotOfJson(row.after);
  const canUndo = isUndoable(
    { kind, status, noop: row.noop, appliedAt: row.appliedAt },
    now,
  );
  const indexNowState =
    typeof row.indexNow === "object" && row.indexNow !== null
      ? oneOf(
          String((row.indexNow as { state?: unknown }).state),
          INDEX_NOW_STATES,
        )
      : null;
  return {
    id: row.id,
    kind,
    title: row.title,
    status,
    statusLabel:
      SEO_CHANGE_STATUS_LABEL[displayStatusOf(status, extra.approvalStatus)],
    source: oneOf(row.source, SOURCES) ?? "ACTION",
    createdAt: row.createdAt.toISOString(),
    resolvedAt: resolvedAtOf(row, status)?.toISOString() ?? null,
    expiresAt: status === "PROPOSED" ? row.expiresAt.toISOString() : null,
    approvalId: row.approvalId,
    canDecide:
      status === "PROPOSED" &&
      extra.viewerIsManager &&
      extra.approvalStatus === "PENDING",
    canUndo,
    canMakeLive:
      kind === "PUBLISH_ARTICLE" &&
      status === "VERIFIED" &&
      !row.noop &&
      !extra.hasOpenLive &&
      // Yazı zaten canlıysa (yayın VERIFIED) tekrar öneri sunulmaz.
      after?.status !== "publish",
    undoWarning: canUndo ? changeUndoWarning(kind) : null,
    noop: row.noop,
    preview: previewOf(row, status),
    link: row.liveUrl ?? row.targetUrl,
    draft: kind === "PUBLISH_ARTICLE" && after?.status !== "publish",
    indexNow: indexNowState,
    error: status === "FAILED" || row.error ? errorOf(row.error) : null,
  };
}

export async function getChangeInProject(
  projectId: string,
  changeId: string,
): Promise<SeoChange | null> {
  return prisma.seoChange.findFirst({ where: { id: changeId, projectId } });
}

// Yeniden eskiye; süreç kipine uyan satırlar (mock ile gerçek karışmaz).
export async function listRecentChanges(
  projectId: string,
  limit: number = DEFAULT_LIST,
): Promise<SeoChange[]> {
  return prisma.seoChange.findMany({
    where: { projectId, isMock: applyMockMode() },
    orderBy: { createdAt: "desc" },
    take: Math.min(LIST_MAX, Math.max(1, Math.floor(limit))),
  });
}
