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
    return error instanceof Error ? error.message : "Operation failed";
  }
  if (error.googleErrorCode === "invalid_grant") {
    return "Google: The connection's authorization has become invalid — you need to reconnect.";
  }
  if (error.googleErrorCode === "access_denied") {
    return "Google: Access denied.";
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
      return { ok: false, message: "Google connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    const property = metadata.ga4Properties?.find(
      (p) => p.propertyId === propertyId,
    );
    if (!property) {
      return { ok: false, message: "Invalid GA4 property selection" };
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

    revalidatePath(`/projects/${projectId}/integrations`);
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
      return { ok: false, message: "Google connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    const site = metadata.searchConsoleSites?.find(
      (s) => s.siteUrl === siteUrl,
    );
    if (!site) {
      return { ok: false, message: "Invalid Search Console site selection" };
    }

    const nextMetadata: GoogleCredentialMetadata = {
      ...metadata,
      selectedSearchConsoleSite: site.siteUrl,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Performs a real read for the selected property/site by actually using the
// refresh token against Google — a fake "connected" state is never produced.
export async function testGoogleConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as GoogleCredentialMetadata;
    if (
      !metadata.selectedGa4PropertyId &&
      !metadata.selectedSearchConsoleSite
    ) {
      return {
        ok: false,
        message: "Select a GA4 property or Search Console site first",
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

    revalidatePath(`/projects/${projectId}/integrations`);
    if (lastTestResult.error) {
      return { ok: false, message: lastTestResult.error };
    }
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Re-fetches the GA4 property / Search Console site list against Google —
// this is the only way to update after connecting if a new property/site
// was added on Google's side (or access was removed) without going through
// OAuth again.
export async function refreshGoogleListsAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Google connection not found" };
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

    revalidatePath(`/projects/${projectId}/integrations`);
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

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
