import "server-only";

import type { AdsAccount } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeAdAccountId } from "@/lib/ads/account-id";
import {
  META_PROVIDER,
  type MetaAdsMetadata,
} from "@/server/integrations/meta-client";
import { decryptSecret } from "@/server/security/crypto";

// Reklam hesabı modeli (docs/meta-ads-plan.md §4, F1). Bir projenin Meta Ads
// hesabını çözmenin tek yeri: Ads modülü (modules/ads/account.ts), Ads
// account sayfası ve analiz okumaları (MetaAdsQuery.resolveConnection) buradan
// okur. AdsAccount satırı ilk okumada bağlantı metadata'sından tembelce
// oluşturulur (ayrı bir backfill adımı gerekmez) ve projeye AdsAccountProject
// ile bağlanır; v1'de proje başına tek seçili hesap (K10).

export type AdsAccountStatus =
  "needs-connect" | "needs-account" | "needs-page" | "ready";

export type ResolvedAdsAccount = {
  status: AdsAccountStatus;
  credentialId?: string;
  workspaceId?: string;
  adAccountId?: string;
  adAccountName?: string;
  currency?: string;
  timezoneName?: string;
  pageId?: string;
  pageName?: string;
  // AdsAccount.id (tembel oluşturulmuş satır).
  adsAccountRowId?: string;
  healthStatus?: string;
  healthReason?: string | null;
  rateLimitedUntil?: Date | null;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function currencyOf(value: unknown): string | undefined {
  const code = text(value)?.toUpperCase();
  return code && /^[A-Z]{3}$/.test(code) ? code : undefined;
}

// Seçili hesabın AdsAccount satırı (yoksa oluşturur) ve projeye bağı.
// Hata durumunda null: hesap modeli okunamazsa çağıranlar metadata ile
// devam eder, hiçbir ekran bu yüzden düşmez.
export async function ensureAdsAccountRow(input: {
  workspaceId: string;
  projectId: string;
  brandId: string;
  credentialId: string;
  externalId: string;
  name?: string;
  currency?: string;
  pageId?: string;
}): Promise<AdsAccount | null> {
  const externalId = normalizeAdAccountId(input.externalId);
  try {
    // Çoğu okumada satır zaten günceldir: yazım yapılmaz.
    const existing = await prisma.adsAccount.findUnique({
      where: {
        workspaceId_platform_externalId: {
          workspaceId: input.workspaceId,
          platform: "META",
          externalId,
        },
      },
      include: {
        projects: {
          where: { projectId: input.projectId },
          select: { selected: true },
        },
      },
    });
    if (
      existing &&
      existing.credentialId === input.credentialId &&
      (!input.name || existing.name === input.name) &&
      (!input.currency || existing.currency === input.currency) &&
      (!input.pageId || existing.pageId === input.pageId) &&
      existing.projects[0]?.selected
    ) {
      return existing;
    }
    const row = await prisma.adsAccount.upsert({
      where: {
        workspaceId_platform_externalId: {
          workspaceId: input.workspaceId,
          platform: "META",
          externalId,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        credentialId: input.credentialId,
        externalId,
        name: input.name,
        currency: input.currency,
        pageId: input.pageId,
      },
      update: {
        credentialId: input.credentialId,
        ...(input.name ? { name: input.name } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
        ...(input.pageId ? { pageId: input.pageId } : {}),
      },
    });
    await selectAdsAccountForProject({
      adsAccountId: row.id,
      projectId: input.projectId,
      brandId: input.brandId,
    });
    return row;
  } catch (error) {
    console.error(
      "[ads-accounts] account row could not be written:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

// Projenin seçili hesabı tektir: seçim değişince eski bağ seçimsiz kalır.
export async function selectAdsAccountForProject(input: {
  adsAccountId: string;
  projectId: string;
  brandId: string;
}): Promise<void> {
  await prisma.$transaction([
    prisma.adsAccountProject.updateMany({
      where: {
        projectId: input.projectId,
        selected: true,
        adsAccountId: { not: input.adsAccountId },
      },
      data: { selected: false },
    }),
    prisma.adsAccountProject.upsert({
      where: {
        adsAccountId_projectId: {
          adsAccountId: input.adsAccountId,
          projectId: input.projectId,
        },
      },
      create: {
        adsAccountId: input.adsAccountId,
        projectId: input.projectId,
        brandId: input.brandId,
        selected: true,
      },
      update: { selected: true },
    }),
  ]);
}

export const AdsAccounts = {
  // Projenin Meta Ads hesabı: bağlantı durumu, seçili hesap, para birimi,
  // Sayfa ve (varsa) hesap sağlığı. Token okunmaz.
  async resolve(projectId: string): Promise<ResolvedAdsAccount> {
    const credential = await prisma.integrationCredential.findUnique({
      where: { projectId_provider: { projectId, provider: META_PROVIDER.ads } },
      select: {
        id: true,
        status: true,
        metadata: true,
        workspaceId: true,
        brandId: true,
      },
    });
    if (!credential || credential.status !== "ACTIVE") {
      return { status: "needs-connect" };
    }
    const metadata = (credential.metadata ?? {}) as Partial<MetaAdsMetadata>;
    const selected = text(metadata.selectedAdAccountId);
    if (!selected) {
      return {
        status: "needs-account",
        credentialId: credential.id,
        workspaceId: credential.workspaceId,
      };
    }
    const adAccountId = normalizeAdAccountId(selected);
    const listed = Array.isArray(metadata.adAccounts)
      ? metadata.adAccounts.find(
          (row) =>
            row?.adAccountId &&
            normalizeAdAccountId(row.adAccountId) === adAccountId,
        )
      : undefined;
    const pageId = text(metadata.selectedPageId);
    const page = Array.isArray(metadata.pages)
      ? metadata.pages.find((row) => row?.pageId === pageId)
      : undefined;

    const row = await ensureAdsAccountRow({
      workspaceId: credential.workspaceId,
      projectId,
      brandId: credential.brandId,
      credentialId: credential.id,
      externalId: adAccountId,
      name: text(listed?.adAccountName) ?? text(metadata.selectedAdAccountName),
      currency: currencyOf(listed?.currency),
      pageId: page ? pageId : undefined,
    });

    const base: ResolvedAdsAccount = {
      status: page ? "ready" : "needs-page",
      credentialId: credential.id,
      workspaceId: credential.workspaceId,
      adAccountId,
      adAccountName:
        text(listed?.adAccountName) ??
        text(metadata.selectedAdAccountName) ??
        row?.name ??
        undefined,
      currency: currencyOf(listed?.currency) ?? row?.currency ?? undefined,
      timezoneName: row?.timezoneName ?? undefined,
      ...(page
        ? {
            pageId,
            pageName: text(page.pageName) ?? text(metadata.selectedPageName),
          }
        : {}),
      ...(row
        ? {
            adsAccountRowId: row.id,
            healthStatus: row.healthStatus,
            healthReason: row.healthReason,
            rateLimitedUntil: row.rateLimitedUntil,
          }
        : {}),
    };
    return base;
  },

  // Token gerekenler için (okuma sorguları, senkron): yalnız ACTIVE bağlantı.
  async resolveWithToken(projectId: string): Promise<
    | (ResolvedAdsAccount & {
        status: "ready" | "needs-page";
        adAccountId: string;
        credentialId: string;
        accessToken: string;
      })
    | ResolvedAdsAccount
  > {
    const resolved = await this.resolve(projectId);
    if (
      (resolved.status !== "ready" && resolved.status !== "needs-page") ||
      !resolved.credentialId ||
      !resolved.adAccountId
    ) {
      return resolved;
    }
    const credential = await prisma.integrationCredential.findUnique({
      where: { id: resolved.credentialId },
      select: { encryptedSecret: true },
    });
    if (!credential?.encryptedSecret) return { status: "needs-connect" };
    return {
      ...resolved,
      status: resolved.status,
      adAccountId: resolved.adAccountId,
      credentialId: resolved.credentialId,
      accessToken: decryptSecret(credential.encryptedSecret),
    };
  },
};
