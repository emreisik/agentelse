"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { decryptSecret } from "@/server/security/crypto";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  MetaApiError,
  fetchMetaAdsInsights,
  fetchPageAccessToken,
  verifyInstagramAccess,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeMetaError(error: unknown): string {
  if (!(error instanceof MetaApiError)) {
    return error instanceof Error ? error.message : "İşlem başarısız";
  }
  // 190 = OAuthException (token süresi dolmuş/iptal edilmiş) — Meta'nın
  // long-lived token'ları Google'ın refresh token'ı gibi otomatik
  // yenilenmiyor, kullanıcı yeniden bağlanmalı.
  if (error.metaErrorCode === 190) {
    return "Meta: Bağlantının izni geçersiz hale gelmiş — yeniden bağlanmanız gerekiyor.";
  }
  return `Meta: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeMetaError(error) };
}

function loadCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "meta" } },
  });
}

export async function selectMetaPageAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const pageId = String(formData.get("pageId") ?? "").trim();
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Meta bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    const page = metadata.pages?.find((p) => p.pageId === pageId);
    if (!page) {
      return { ok: false, message: "Geçersiz Page seçimi" };
    }

    const nextMetadata: MetaCredentialMetadata = {
      ...metadata,
      selectedPageId: page.pageId,
      selectedPageName: page.pageName,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function selectMetaAdAccountAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const adAccountId = String(formData.get("adAccountId") ?? "").trim();
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Meta bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    const account = metadata.adAccounts?.find(
      (a) => a.adAccountId === adAccountId,
    );
    if (!account) {
      return { ok: false, message: "Geçersiz reklam hesabı seçimi" };
    }

    const nextMetadata: MetaCredentialMetadata = {
      ...metadata,
      selectedAdAccountId: account.adAccountId,
      selectedAdAccountName: account.adAccountName,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Long-lived token'ı gerçekten Meta'ya karşı kullanarak seçili Page/reklam
// hesabı için bir okuma yapar — sahte bir "bağlandı" durumu asla üretilmez.
export async function testMetaConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Meta bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    if (!metadata.selectedPageId && !metadata.selectedAdAccountId) {
      return {
        ok: false,
        message: "Önce bir Page veya reklam hesabı seçin",
      };
    }

    const accessToken = decryptSecret(credential.encryptedSecret);
    const lastTestResult: NonNullable<
      MetaCredentialMetadata["lastTestResult"]
    > = { testedAt: new Date().toISOString() };

    try {
      const page = metadata.pages?.find(
        (p) => p.pageId === metadata.selectedPageId,
      );
      if (page?.instagramBusinessAccountId) {
        const pageAccessToken = await fetchPageAccessToken(
          page.pageId,
          accessToken,
        );
        lastTestResult.igUsername = await verifyInstagramAccess(
          page.instagramBusinessAccountId,
          pageAccessToken,
        );
      }
      if (metadata.selectedAdAccountId) {
        const insights = await fetchMetaAdsInsights({
          adAccountId: metadata.selectedAdAccountId,
          accessToken,
        });
        lastTestResult.adAccountSpend = insights.spend;
      }
    } catch (error) {
      if (error instanceof MetaApiError && error.metaErrorCode === 190) {
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: { status: "EXPIRED" },
        });
      }
      lastTestResult.error = describeMetaError(error);
    }

    const nextMetadata: MetaCredentialMetadata = {
      ...metadata,
      lastTestResult,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        metadata: nextMetadata,
        status: lastTestResult.error ? credential.status : "ACTIVE",
      },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    if (lastTestResult.error) {
      return { ok: false, message: lastTestResult.error };
    }
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectMetaAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    const access = await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) return { ok: true };

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { status: "REVOKED" },
    });

    await AuditLogRepository.record({
      workspaceId: access.workspaceId,
      projectId,
      actorType: "USER",
      actorId: userId,
      action: "integration_credential.disconnected",
      entityType: "IntegrationCredential",
      entityId: credential.id,
      metadata: { provider: "meta" },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
