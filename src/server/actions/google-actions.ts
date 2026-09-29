"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  GOOGLE_PROVIDER,
  GOOGLE_SERVICE_LABEL,
  GoogleApiError,
  fetchGa4PropertyList,
  fetchGa4Report,
  fetchSearchConsoleReport,
  fetchSearchConsoleSiteList,
  parseGoogleService,
  reconcileGa4Selection,
  reconcileSearchConsoleSelection,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
  type GoogleService,
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

function notFound(service: GoogleService): ActionResult {
  return {
    ok: false,
    message: `${GOOGLE_SERVICE_LABEL[service]} connection not found`,
  };
}

function loadCredential(projectId: string, service: GoogleService) {
  return prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId, provider: GOOGLE_PROVIDER[service] },
    },
  });
}

// Every action carries `projectId` + `service` in its form; access is
// verified before anything is read.
async function resolveScope(formData: FormData) {
  const projectId = String(formData.get("projectId"));
  const service = parseGoogleService(formData.get("service"));
  if (!service) throw new Error("Invalid Google service");
  const { userId } = await requireUser();
  const access = await requireProjectAccess(userId, projectId);
  return { projectId, service, userId, access };
}

export async function selectGa4PropertyAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const propertyId = String(formData.get("propertyId") ?? "").trim();
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId, "analytics");
    if (!credential) return notFound("analytics");

    const metadata = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
    const property = metadata.ga4Properties?.find(
      (p) => p.propertyId === propertyId,
    );
    if (!property) {
      return { ok: false, message: "Invalid GA4 property selection" };
    }

    const nextMetadata: GoogleAnalyticsMetadata = {
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

    const credential = await loadCredential(projectId, "search_console");
    if (!credential) return notFound("search_console");

    const metadata = (credential.metadata ?? {}) as GoogleSearchConsoleMetadata;
    const site = metadata.searchConsoleSites?.find(
      (s) => s.siteUrl === siteUrl,
    );
    if (!site) {
      return { ok: false, message: "Invalid Search Console site selection" };
    }

    const nextMetadata: GoogleSearchConsoleMetadata = {
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
    const { projectId, service } = await resolveScope(formData);

    const credential = await loadCredential(projectId, service);
    if (!credential) return notFound(service);

    let testError: string | undefined;
    let nextMetadata: GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;

    if (service === "analytics") {
      const metadata = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
      if (!metadata.selectedGa4PropertyId) {
        return { ok: false, message: "Select a GA4 property first" };
      }
      const accessToken = await getFreshGoogleAccessToken(credential);
      const result: NonNullable<GoogleAnalyticsMetadata["lastTestResult"]> = {
        testedAt: new Date().toISOString(),
      };
      try {
        const ga4 = await fetchGa4Report(
          accessToken,
          metadata.selectedGa4PropertyId,
        );
        result.ga4ActiveUsers = ga4.activeUsers;
      } catch (error) {
        result.error = describeGoogleError(error);
      }
      testError = result.error;
      nextMetadata = { ...metadata, lastTestResult: result };
    } else {
      const metadata = (credential.metadata ??
        {}) as GoogleSearchConsoleMetadata;
      if (!metadata.selectedSearchConsoleSite) {
        return { ok: false, message: "Select a Search Console site first" };
      }
      const accessToken = await getFreshGoogleAccessToken(credential);
      const result: NonNullable<GoogleSearchConsoleMetadata["lastTestResult"]> =
        { testedAt: new Date().toISOString() };
      try {
        const gsc = await fetchSearchConsoleReport(
          accessToken,
          metadata.selectedSearchConsoleSite,
        );
        result.gscClicks = gsc.clicks;
        result.gscImpressions = gsc.impressions;
      } catch (error) {
        result.error = describeGoogleError(error);
      }
      testError = result.error;
      nextMetadata = { ...metadata, lastTestResult: result };
    }

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata, status: "ACTIVE" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return testError ? { ok: false, message: testError } : { ok: true };
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
    const { projectId, service } = await resolveScope(formData);

    const credential = await loadCredential(projectId, service);
    if (!credential) return notFound(service);

    const accessToken = await getFreshGoogleAccessToken(credential);

    let listError: string | undefined;
    let nextMetadata: GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata;
    if (service === "analytics") {
      const existing = (credential.metadata ?? {}) as GoogleAnalyticsMetadata;
      const lists = await fetchGa4PropertyList(accessToken);
      listError = lists.ga4ListError;
      nextMetadata = {
        ...existing,
        ga4ListError: undefined,
        ...lists,
        ...reconcileGa4Selection(existing, lists),
      };
    } else {
      const existing = (credential.metadata ??
        {}) as GoogleSearchConsoleMetadata;
      const lists = await fetchSearchConsoleSiteList(accessToken);
      listError = lists.gscListError;
      nextMetadata = {
        ...existing,
        gscListError: undefined,
        ...lists,
        ...reconcileSearchConsoleSelection(existing, lists),
      };
    }

    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: { metadata: nextMetadata, status: "ACTIVE" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return listError ? { ok: false, message: listError } : { ok: true };
  } catch (error) {
    return fail(error);
  }
}

export async function disconnectGoogleAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const { projectId, service, userId, access } = await resolveScope(formData);

    const credential = await loadCredential(projectId, service);
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
      metadata: { provider: GOOGLE_PROVIDER[service] },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
