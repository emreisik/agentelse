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
    return error instanceof Error ? error.message : "Operation failed";
  }
  // 190 = OAuthException (token expired/revoked) — unlike Google's refresh
  // token, Meta's long-lived tokens don't renew automatically, the user has
  // to reconnect.
  if (error.metaErrorCode === 190) {
    return "Meta: The connection's authorization has become invalid — you need to reconnect.";
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
      return { ok: false, message: "Meta connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    const page = metadata.pages?.find((p) => p.pageId === pageId);
    if (!page) {
      return { ok: false, message: "Invalid Page selection" };
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

    revalidatePath(`/projects/${projectId}/integrations`);
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
      return { ok: false, message: "Meta connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    const account = metadata.adAccounts?.find(
      (a) => a.adAccountId === adAccountId,
    );
    if (!account) {
      return { ok: false, message: "Invalid ad account selection" };
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

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}

// Performs a real read for the selected Page/ad account by actually using
// the long-lived token against Meta — a fake "connected" state is never
// produced.
export async function testMetaConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "Meta connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as MetaCredentialMetadata;
    if (!metadata.selectedPageId && !metadata.selectedAdAccountId) {
      return {
        ok: false,
        message: "Select a Page or ad account first",
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

    revalidatePath(`/projects/${projectId}/integrations`);
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

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
