import "server-only";

import { prisma } from "@/lib/prisma";
import { parseBrandingSnapshot } from "@/lib/report-share/branding";
import {
  LOGO_MIME_TYPES,
  type BrandingSnapshot,
} from "@/lib/report-share/types";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";

// Workspace başına beyaz etiket markası (SC-F9 ve GA-F8 ortak). Bilinçli
// istisna: projectId yok, marka projeler arası ortaktır. Paylaşım oluşturulurken
// bu satır ReportShare.branding'e KOPYALANIR; sonradan değişiklik gönderilmiş
// bağlantıları yeniden yazmaz.

const LOGO_OPTION_LIMIT = 12;

export const ReportBrandings = {
  async get(workspaceId: string): Promise<BrandingSnapshot> {
    const row = await prisma.reportBranding.findUnique({
      where: { workspaceId },
      select: {
        displayName: true,
        accent: true,
        footer: true,
        logoAssetId: true,
      },
    });
    if (row) return parseBrandingSnapshot(row, "");
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    return parseBrandingSnapshot({}, workspace?.name ?? "");
  },

  async save(input: {
    workspaceId: string;
    userId: string;
    value: BrandingSnapshot;
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    const { workspaceId, userId, value } = input;
    if (value.logoAssetId) {
      // Logo bu workspace'in, LOGO türünde ve sunulabilir bir görsel olmalı.
      const asset = await prisma.asset.findFirst({
        where: {
          id: value.logoAssetId,
          workspaceId,
          type: "LOGO",
          mimeType: { in: [...LOGO_MIME_TYPES] },
        },
        select: { id: true },
      });
      if (!asset) return { ok: false, message: "Choose a logo from the list." };
    }
    const data = {
      displayName: value.displayName,
      accent: value.accent,
      footer: value.footer,
      logoAssetId: value.logoAssetId,
      updatedByUserId: userId,
    };
    const row = await prisma.reportBranding.upsert({
      where: { workspaceId },
      create: { workspaceId, ...data },
      update: data,
      select: { id: true },
    });
    await AuditLogRepository.record({
      workspaceId,
      actorType: "USER",
      actorId: userId,
      action: "report_branding.saved",
      entityType: "ReportBranding",
      entityId: row.id,
      metadata: {},
    });
    return { ok: true };
  },

  async logoOptions(
    workspaceId: string,
  ): Promise<{ id: string; filename: string }[]> {
    return prisma.asset.findMany({
      where: {
        workspaceId,
        type: "LOGO",
        mimeType: { in: [...LOGO_MIME_TYPES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LOGO_OPTION_LIMIT,
      select: { id: true, filename: true },
    });
  },
};
