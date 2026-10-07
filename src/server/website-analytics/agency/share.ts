import "server-only";

import { prisma } from "@/lib/prisma";
import { gaAgencyEnabledFor } from "@/lib/website-analytics/agency/flags";
import { isGaEngineLink } from "@/lib/website-analytics/agency/scope";
import { readWebsiteReportCard } from "@/lib/website-analytics/reports/card";
import {
  variantOfCommandId,
  websiteWorkId,
} from "@/lib/website-analytics/reports/ids";
import type { WebsiteReportCardData } from "@/lib/website-analytics/reports/types";
import { appUrl } from "@/lib/app-url";
import { ReportBrandings } from "@/server/report-share/branding";
import {
  ReportShares,
  type ReportShareView,
} from "@/server/report-share/store";

// GA-F8 white-label: WEBSITE tarafının SC-F9 paylaşım modülüne köprüsü
// (docs/website-agency.md). Tüm paylaşım gizli parça, marka anlık görüntüsü,
// sınır ve denetim kaydı SC-F9'un ReportShares/ReportBrandings'indedir; burada
// yalnız "hangi GA kartı paylaşılabilir" kararı ve rapor kimliği (Command id)
// bulunur. SC-F9 imzaları değişirse uyarlama yalnız bu dosyada yapılır.
// Her işlev, GA_AGENCY kapalıyken ya da proje yerel izin listesinde değilken
// hiçbir sorgu atmadan döner.

// WhiteLabelFrame'in varsayılan alt bilgisi Search Console der; GA anlık
// görüntüsüne kendi cümlemizi yazarız.
export const WEBSITE_SHARE_FOOTER_FALLBACK = "Numbers from Google Analytics.";

function cardOf(parsedIntent: unknown): unknown {
  return parsedIntent && typeof parsedIntent === "object"
    ? (parsedIntent as { card?: unknown }).card
    : null;
}

// Kimlik örüntüsüne asla tek başına güvenilmez: Command satırı bu projenin
// Website analytics Work'ünde SYSTEM kaydı olmalı, kartın projesi eşleşmeli
// ve kartın GA bağı bu projede, motor bağı olmalı.
export async function loadWebsiteReportForClient(input: {
  projectId: string;
  commandId: string;
  allowPlan: boolean;
}): Promise<WebsiteReportCardData | null> {
  const { projectId, commandId, allowPlan } = input;
  if (!gaAgencyEnabledFor(projectId)) return null;
  const variant = variantOfCommandId(commandId);
  if (
    variant !== "weekly" &&
    variant !== "monthly" &&
    !(allowPlan && variant === "plan")
  ) {
    return null;
  }
  const row = await prisma.command.findFirst({
    where: {
      id: commandId,
      projectId,
      workId: websiteWorkId(projectId),
      source: "SYSTEM",
    },
    select: { parsedIntent: true },
  });
  if (!row) return null;
  const card = readWebsiteReportCard(cardOf(row.parsedIntent));
  if (!card || card.variant !== variant || card.projectId !== projectId) {
    return null;
  }
  const link = await prisma.gaPropertyLink.findFirst({
    where: { id: card.linkId, projectId },
    select: { isPrimary: true, isSecondary: true },
  });
  if (!link || !isGaEngineLink(link)) return null;
  return card;
}

export type WebsiteShareCreateResult =
  | { ok: true; url: string; expiresAt: string }
  | {
      ok: false;
      reason: "off" | "bad_report" | "limit" | "bad_days" | "not_confirmed";
    };

// Yalnız haftalık ve aylık kart paylaşılır (plan hiçbir zaman). Gizli parça
// yalnız dönen adreste vardır; saklanmaz ve günlüğe yazılmaz.
export async function createWebsiteReportShare(input: {
  workspaceId: string;
  projectId: string;
  userId: string;
  commandId: string;
  days: number;
  confirmPublic: boolean;
  now?: Date;
}): Promise<WebsiteShareCreateResult> {
  const { workspaceId, projectId, userId, commandId, days } = input;
  if (!gaAgencyEnabledFor(projectId)) return { ok: false, reason: "off" };
  if (input.confirmPublic !== true) {
    return { ok: false, reason: "not_confirmed" };
  }
  const card = await loadWebsiteReportForClient({
    projectId,
    commandId,
    allowPlan: false,
  });
  if (!card) return { ok: false, reason: "bad_report" };

  const live = await ReportBrandings.get(workspaceId);
  const branding = {
    ...live,
    footer: live.footer?.trim() ? live.footer : WEBSITE_SHARE_FOOTER_FALLBACK,
  };
  const result = await ReportShares.create({
    workspaceId,
    projectId,
    kind: "WEBSITE",
    reportId: commandId,
    days,
    userId,
    branding,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.code === "INVALID_DAYS" ? "bad_days" : "limit",
    };
  }
  return {
    ok: true,
    url: appUrl(`/r/${result.token}`).toString(),
    expiresAt: result.expiresAt.toISOString(),
  };
}

export async function listWebsiteReportShares(
  projectId: string,
  commandIds: readonly string[],
): Promise<Record<string, ReportShareView[]>> {
  if (!gaAgencyEnabledFor(projectId) || commandIds.length === 0) return {};
  return ReportShares.listForProject(projectId, "WEBSITE", commandIds);
}

export async function revokeWebsiteReportShare(input: {
  projectId: string;
  shareId: string;
  userId: string;
}): Promise<boolean> {
  if (!gaAgencyEnabledFor(input.projectId)) return false;
  return ReportShares.revoke(input);
}
