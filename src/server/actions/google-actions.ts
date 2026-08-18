"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  GoogleApiError,
  fetchGa4Report,
  fetchGoogleLists,
  fetchSearchConsoleReport,
  reconcileGoogleSelection,
  type GoogleCredentialMetadata,
} from "@/server/integrations/google-client";
import { getFreshGoogleAccessToken } from "@/server/integrations/google-token";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeGoogleError(error: unknown): string {
  if (!(error instanceof GoogleApiError)) {
    return error instanceof Error ? error.message : "İşlem başarısız";
  }
  if (error.googleErrorCode === "invalid_grant") {
    return "Google: Bağlantının izni geçersiz hale gelmiş — yeniden bağlanmanız gerekiyor.";
  }
  if (error.googleErrorCode === "access_denied") {
    return "Google: Erişim reddedildi.";
  }
  return `Google: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeGoogleError(error) };
}

function loadCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "google" } },
  });
}

export async function selectGa4PropertyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const propertyId = String(formData.get("propertyId") ?? "").trim();
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    const property = metadata.ga4Properties?.find(
      (p) => p.propertyId === propertyId,
    );
    if (!property) {
      return { ok: false, message: "Geçersiz GA4 property seçimi" };
    }

    const nextMetadata: GoogleCredentialMetadata = {
      ...metadata,
      selectedGa4PropertyId: property.propertyId,
      selectedGa4PropertyName: property.propertyName,
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

export async function selectSearchConsoleSiteAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const siteUrl = String(formData.get("siteUrl") ?? "").trim();
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    const site = metadata.searchConsoleSites?.find(
      (s) => s.siteUrl === siteUrl,
    );
    if (!site) {
      return { ok: false, message: "Geçersiz Search Console site seçimi" };
    }

    const nextMetadata: GoogleCredentialMetadata = {
      ...metadata,
      selectedSearchConsoleSite: site.siteUrl,
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

// Refresh token'ı gerçekten Google'a karşı kullanarak seçili property/site
// için bir okuma yapar — sahte bir "bağlandı" durumu asla üretilmez.
export async function testGoogleConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google bağlantısı bulunamadı" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    if (
      !metadata.selectedGa4PropertyId &&
      !metadata.selectedSearchConsoleSite
    ) {
      return {
        ok: false,
        message: "Önce bir GA4 property veya Search Console site seçin",
      };
    }

    const accessToken = await getFreshGoogleAccessToken(credential);

    const lastTestResult: NonNullable<
      GoogleCredentialMetadata["lastTestResult"]
    > = { testedAt: new Date().toISOString() };
    try {
      if (metadata.selectedGa4PropertyId) {
        const ga4 = await fetchGa4Report(
          accessToken,
          metadata.selectedGa4PropertyId,
        );
        lastTestResult.ga4ActiveUsers = ga4.activeUsers;
      }
      if (metadata.selectedSearchConsoleSite) {
        const gsc = await fetchSearchConsoleReport(
          accessToken,
          metadata.selectedSearchConsoleSite,
        );
        lastTestResult.gscClicks = gsc.clicks;
        lastTestResult.gscImpressions = gsc.impressions;
      }
    } catch (error) {
      lastTestResult.error = describeGoogleError(error);
    }

    const nextMetadata: GoogleCredentialMetadata = {
      ...metadata,
      lastTestResult,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata, status: "ACTIVE" },
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

// GA4 property / Search Console site listesini Google'a karşı yeniden
// çeker — bağlandıktan sonra Google tarafında yeni bir property/site
// eklenmişse (veya erişim kaldırılmışsa) yeniden OAuth'a gitmeden
// güncellemenin tek yolu bu.
export async function refreshGoogleListsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google bağlantısı bulunamadı" };
    }

    const accessToken = await getFreshGoogleAccessToken(credential);
    const existingMetadata = (credential.metadata ??
      {}) as GoogleCredentialMetadata;
    const lists = await fetchGoogleLists(accessToken);

    const nextMetadata: GoogleCredentialMetadata = {
      ...existingMetadata,
      ...lists,
      ...reconcileGoogleSelection(existingMetadata, lists),
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata, status: "ACTIVE" },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    if (lists.ga4ListError || lists.gscListError) {
      return {
        ok: false,
        message: [lists.ga4ListError, lists.gscListError]
          .filter(Boolean)
          .join(" · "),
      };
    }
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectGoogleAction(
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
      metadata: { provider: "google" },
    });

    revalidatePath(`/projects/${projectId}/entegrasyonlar`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
