import "server-only";

import type { SeoChange } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  SEO_APPLY_REFUSAL_MESSAGES,
  SEO_CHANGE_ERROR_MESSAGES,
  WP_HEALTH_LABEL,
} from "@/lib/seo/apply/copy";
import {
  mockMatchesSite,
  applyMockMode,
  seoApplyEnabledFor,
} from "@/lib/seo/apply/flags";
import { OPEN_CHANGE_STATUSES, rateWindow } from "@/lib/seo/apply/lifecycle";
import type {
  PublishStatusView,
  SeoApplyView,
  SeoChangeView,
  WordPressConnectionView,
} from "@/lib/seo/apply/view-types";
import { loadCmsSite } from "@/server/integrations/wordpress/connection";
import { loadWordPressConnectionView } from "@/server/integrations/wordpress/connect";

import { appliedCountSince } from "./rate";
import { isManagerInline } from "./roles";
import { readApplySettings } from "./settings";
import { parseWpCapabilities } from "./site";
import { changeViewOf, listRecentChanges } from "./store";

// SC-F8 okuyucuları (docs/website-apply.md "Arayüz"): Search sayfasındaki
// "Website changes" bölümü ve makale kartındaki "Publish to WordPress"
// durumu. Yalnız sayfa ve eylem katmanından çağrılır; tenant-context bu
// dosyada yoktur, görüntüleyicinin rolü satır içi aranır (roles.ts).
// Bayrak kapalıyken sorgusuz null. Çıktı serileştirilebilir (ISO metin).

const VIEW_CHANGES = 30;
const DAY_MS = 24 * 3_600_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// PROPOSED satırların onay durumları (karar satırdan önce Approval'da görünür).
async function approvalStatusMap(
  rows: readonly SeoChange[],
): Promise<Map<string, string>> {
  const ids = rows
    .filter((row) => row.status === "PROPOSED" && row.approvalId)
    .map((row) => row.approvalId as string);
  if (ids.length === 0) return new Map();
  const approvals = await prisma.approval.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  return new Map(approvals.map((row) => [row.id, row.status]));
}

// Açık bir PUBLISH_LIVE değişikliği olan taslak değişiklik kimlikleri
// ("Make it live" düğmesi bunlar için kapanır).
async function openLiveDraftIds(
  projectId: string,
  rows: readonly SeoChange[],
): Promise<Set<string>> {
  if (!rows.some((row) => row.kind === "PUBLISH_ARTICLE")) return new Set();
  const live = await prisma.seoChange.findMany({
    where: { projectId, kind: "PUBLISH_LIVE", openKey: { not: null } },
    select: { params: true },
  });
  const ids = new Set<string>();
  for (const row of live) {
    if (isRecord(row.params) && typeof row.params.draftChangeId === "string") {
      ids.add(row.params.draftChangeId);
    }
  }
  return ids;
}

function disconnectedView(canManage: boolean): WordPressConnectionView {
  return {
    connected: false,
    siteId: null,
    origin: null,
    host: null,
    accountLabel: null,
    health: "UNKNOWN",
    healthLabel: WP_HEALTH_LABEL.UNKNOWN,
    healthReason: null,
    seoPlugin: "NONE",
    descriptionWritable: false,
    capabilities: null,
    lastCheckedAt: null,
    canManage,
    adminWarning: false,
    canRebind: false,
  };
}

export async function loadSeoApplyView(input: {
  projectId: string;
  userId: string;
  now?: Date;
}): Promise<SeoApplyView | null> {
  const { projectId, userId } = input;
  if (!seoApplyEnabledFor(projectId)) return null;
  const now = input.now ?? new Date();

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) return null;

  const [viewerIsManager, site, connection, rows, settings] = await Promise.all(
    [
      isManagerInline(userId, project.workspaceId),
      loadCmsSite(projectId),
      loadWordPressConnectionView(projectId, userId),
      listRecentChanges(projectId, VIEW_CHANGES),
      readApplySettings(projectId),
    ],
  );

  const [approvals, liveDraftIds, applied] = await Promise.all([
    approvalStatusMap(rows),
    openLiveDraftIds(projectId, rows),
    site
      ? appliedCountSince(site.id, new Date(now.getTime() - DAY_MS))
      : Promise.resolve([]),
  ]);

  const changes: SeoChangeView[] = rows.map((row) =>
    changeViewOf(
      row,
      {
        approvalStatus: row.approvalId
          ? (approvals.get(row.approvalId) ?? null)
          : null,
        viewerIsManager,
        hasOpenLive: liveDraftIds.has(row.id),
      },
      now,
    ),
  );

  return {
    connection: connection ?? disconnectedView(viewerIsManager),
    canManage: viewerIsManager,
    dailyLimit: settings.dailyLimit,
    usedToday: rateWindow(applied, settings.dailyLimit, now).used,
    changes,
    indexNow: settings.indexNow,
  };
}

// Makale kartının durumu: Creative için son PUBLISH_ARTICLE ve PUBLISH_LIVE
// değişiklikleri, iki tür için de saklanan creativeId sütunuyla bulunur (JSON
// yol süzgeci yok). Bayrak kapalıyken sorgusuz null.
export async function loadPublishStatus(input: {
  projectId: string;
  creativeId: string;
  userId: string;
  now?: Date;
}): Promise<PublishStatusView | null> {
  const { projectId, creativeId, userId } = input;
  if (!seoApplyEnabledFor(projectId)) return null;
  const now = input.now ?? new Date();
  const connectHref = `/projects/${projectId}/integrations?integration=wordpress`;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  if (!project) return null;

  const [isManager, site, articleRow, liveRow] = await Promise.all([
    isManagerInline(userId, project.workspaceId),
    loadCmsSite(projectId),
    prisma.seoChange.findFirst({
      where: { projectId, creativeId, kind: "PUBLISH_ARTICLE" },
      orderBy: { createdAt: "desc" },
    }),
    prisma.seoChange.findFirst({
      where: { projectId, creativeId, kind: "PUBLISH_LIVE" },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const rows = [articleRow, liveRow].filter(
    (row): row is SeoChange => row !== null,
  );
  const approvals = await approvalStatusMap(rows);
  const viewOf = (row: SeoChange | null, hasOpenLive: boolean) =>
    row
      ? changeViewOf(
          row,
          {
            approvalStatus: row.approvalId
              ? (approvals.get(row.approvalId) ?? null)
              : null,
            viewerIsManager: isManager,
            hasOpenLive,
          },
          now,
        )
      : null;

  const liveIsOpen =
    liveRow !== null &&
    liveRow.openKey !== null &&
    articleRow !== null &&
    isRecord(liveRow.params) &&
    liveRow.params.draftChangeId === articleRow.id;
  const change = viewOf(articleRow, liveIsOpen);
  const liveChange = viewOf(liveRow, false);

  const connected = site !== null;
  const healthy =
    site !== null &&
    mockMatchesSite(applyMockMode(), site.isMock) &&
    (site.health === "OK" || site.health === "LIMITED");
  const canDraft = parseWpCapabilities(site?.capabilities)?.draftPosts === true;
  const inFlight =
    articleRow !== null &&
    (OPEN_CHANGE_STATUSES.includes(
      articleRow.status as (typeof OPEN_CHANGE_STATUSES)[number],
    ) ||
      (articleRow.status === "VERIFIED" && !articleRow.noop));

  let blockedReason: string | null = null;
  if (!connected) blockedReason = SEO_APPLY_REFUSAL_MESSAGES.not_connected;
  else if (!healthy) blockedReason = SEO_APPLY_REFUSAL_MESSAGES.site_unhealthy;
  else if (!canDraft) blockedReason = SEO_CHANGE_ERROR_MESSAGES.no_permission;

  return {
    connected,
    healthy,
    canPropose: blockedReason === null && !inFlight,
    blockedReason,
    change,
    liveChange,
    isManager,
    connectHref,
  };
}
