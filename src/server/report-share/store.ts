import "server-only";

import type { ReportShare } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  formatShareToken,
  generateShareSecret,
  hashShareSecret,
  parseShareToken,
  verifyShareSecret,
} from "@/lib/report-share/token";
import {
  isShareKind,
  MAX_ACTIVE_SHARES_PER_PROJECT,
  REPORT_SHARE_DAYS,
  type BrandingSnapshot,
  type ShareKind,
} from "@/lib/report-share/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Süreli, iptal edilebilir salt-okunur rapor bağlantıları (SC-F9 ve GA-F8
// ortak). Gizli parça yalnız create() dönüşünde vardır; veritabanında yalnız
// sha256 özeti saklanır, günlüğe yazılmaz. Silme yolları (deleteForReports,
// deleteForProject) bayrağa BAĞLI DEĞİLDİR: bayrak kapansa da Disconnect ve
// "Delete stored data" bağlantıları siler.
//
// Dev koruması türe özgüdür: herkese açık okuma yolları (resolve) yerel
// izin listesi bekçisi kullanmaz; SEARCH çizicisi seoReportsOn() ister, GA-F8
// çizicisi kendi bekçisini uygular, saklama gscGlobalWorkAllowedHere() ister.

const DAY_MS = 86_400_000;
const VIEW_TOUCH_MS = 60_000;
const DELETE_CHUNK = 500;
const PER_REPORT_LIMIT = 5;
const LIST_ROW_CAP = 400;

// Satır yokken de aynı karşılaştırma işi yapılsın diye sahte özet.
const DUMMY_HASH = hashShareSecret("report-share-dummy-secret");

export type ReportShareView = {
  id: string;
  kind: ShareKind;
  reportId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  status: "ACTIVE" | "EXPIRED" | "REVOKED";
};

function isShareDays(days: number): boolean {
  return (REPORT_SHARE_DAYS as readonly number[]).includes(days);
}

function statusOf(
  row: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): ReportShareView["status"] {
  if (row.revokedAt) return "REVOKED";
  return row.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
}

export const ReportShares = {
  async create(input: {
    workspaceId: string;
    projectId: string;
    kind: ShareKind;
    reportId: string;
    days: number;
    userId: string;
    branding: BrandingSnapshot;
    now?: Date;
  }): Promise<
    | { ok: true; id: string; token: string; expiresAt: Date }
    | { ok: false; code: "INVALID_DAYS" | "LIMIT" }
  > {
    const now = input.now ?? new Date();
    if (!isShareDays(input.days) || !isShareKind(input.kind)) {
      return { ok: false, code: "INVALID_DAYS" };
    }
    const active = await prisma.reportShare.count({
      where: {
        projectId: input.projectId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (active >= MAX_ACTIVE_SHARES_PER_PROJECT) {
      return { ok: false, code: "LIMIT" };
    }
    const secret = generateShareSecret();
    const expiresAt = new Date(now.getTime() + input.days * DAY_MS);
    const row = await prisma.reportShare.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        kind: input.kind,
        reportId: input.reportId,
        tokenHash: hashShareSecret(secret),
        branding: {
          displayName: input.branding.displayName,
          accent: input.branding.accent,
          footer: input.branding.footer,
          logoAssetId: input.branding.logoAssetId,
        },
        expiresAt,
        createdByUserId: input.userId,
        createdAt: now,
      },
      select: { id: true },
    });
    try {
      await AuditLogRepository.record({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actorType: "USER",
        actorId: input.userId,
        action: "report_share.created",
        entityType: "ReportShare",
        entityId: row.id,
        metadata: { kind: input.kind, shareId: row.id },
      });
    } catch (error) {
      // Denetim yazılamasa da bağlantı oluştu; gizli parça yalnız burada döner.
      console.error(
        "[report-share] audit failed:",
        error instanceof Error ? error.name : "error",
      );
    }
    return {
      ok: true,
      id: row.id,
      token: formatShareToken(row.id, secret),
      expiresAt,
    };
  },

  // TEK sorgu, en yeni önce, rapor başına en çok 5 satır.
  async listForProject(
    projectId: string,
    kind: ShareKind,
    reportIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Record<string, ReportShareView[]>> {
    const result: Record<string, ReportShareView[]> = {};
    if (reportIds.length === 0) return result;
    const rows = await prisma.reportShare.findMany({
      where: { projectId, kind, reportId: { in: [...reportIds] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_ROW_CAP,
    });
    for (const row of rows) {
      const list = (result[row.reportId] ??= []);
      if (list.length >= PER_REPORT_LIMIT) continue;
      list.push({
        id: row.id,
        kind,
        reportId: row.reportId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        viewCount: row.viewCount,
        lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
        status: statusOf(row, now),
      });
    }
    return result;
  },

  // Yalnız bu projenin, henüz iptal edilmemiş bağlantısı iptal edilir.
  async revoke(input: {
    projectId: string;
    shareId: string;
    userId: string;
    now?: Date;
  }): Promise<boolean> {
    const now = input.now ?? new Date();
    const row = await prisma.reportShare.findFirst({
      where: {
        id: input.shareId,
        projectId: input.projectId,
        revokedAt: null,
      },
      select: { id: true, kind: true, workspaceId: true },
    });
    if (!row) return false;
    const updated = await prisma.reportShare.updateMany({
      where: { id: row.id, projectId: input.projectId, revokedAt: null },
      data: { revokedAt: now },
    });
    if (updated.count !== 1) return false;
    try {
      await AuditLogRepository.record({
        workspaceId: row.workspaceId,
        projectId: input.projectId,
        actorType: "USER",
        actorId: input.userId,
        action: "report_share.revoked",
        entityType: "ReportShare",
        entityId: row.id,
        metadata: { kind: row.kind, shareId: row.id },
      });
    } catch (error) {
      console.error(
        "[report-share] audit failed:",
        error instanceof Error ? error.name : "error",
      );
    }
    return true;
  },

  // Bilinmeyen kimlik, yanlış gizli parça, iptal, süre dolması ve bozuk tür
  // aynı sonucu verir ({ ok: false }); ayrım dışarı sızmaz.
  async resolve(
    token: string,
    now: Date = new Date(),
  ): Promise<{ ok: true; share: ReportShare } | { ok: false }> {
    const parsed = parseShareToken(token);
    if (!parsed) return { ok: false };
    const row = await prisma.reportShare.findUnique({
      where: { id: parsed.id },
    });
    // Satır yoksa da karşılaştırma koşar (zamanlama farkı olmasın).
    const secretOk = verifyShareSecret(
      parsed.secret,
      row ? row.tokenHash : DUMMY_HASH,
    );
    if (!row || !secretOk) return { ok: false };
    if (row.revokedAt) return { ok: false };
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false };
    if (!isShareKind(row.kind)) return { ok: false };
    try {
      // Dakikada en çok bir artış: sayaç dışında hiçbir yazma yok.
      await prisma.reportShare.updateMany({
        where: {
          id: row.id,
          OR: [
            { lastViewedAt: null },
            { lastViewedAt: { lt: new Date(now.getTime() - VIEW_TOUCH_MS) } },
          ],
        },
        data: { viewCount: { increment: 1 }, lastViewedAt: now },
      });
    } catch (error) {
      console.error(
        "[report-share] view counter failed:",
        error instanceof Error ? error.name : "error",
      );
    }
    return { ok: true, share: row };
  },

  async deleteForReports(
    kind: ShareKind,
    reportIds: readonly string[],
  ): Promise<number> {
    let total = 0;
    for (let index = 0; index < reportIds.length; index += DELETE_CHUNK) {
      const chunk = reportIds.slice(index, index + DELETE_CHUNK);
      const { count } = await prisma.reportShare.deleteMany({
        where: { kind, reportId: { in: chunk } },
      });
      total += count;
    }
    return total;
  },

  async deleteForProject(kind: ShareKind, projectId: string): Promise<number> {
    const { count } = await prisma.reportShare.deleteMany({
      where: { kind, projectId },
    });
    return count;
  },
};
