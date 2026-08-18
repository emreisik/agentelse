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
  LinkedInApiError,
  fetchLinkedInProfile,
  type LinkedInCredentialMetadata,
} from "@/server/integrations/linkedin-client";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeLinkedInError(error: unknown): string {
  if (!(error instanceof LinkedInApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  if (error.linkedinErrorCode === 401) {
    return "LinkedIn: The connection's authorization has become invalid — you need to reconnect.";
  }
  return `LinkedIn: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeLinkedInError(error) };
}

function loadCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "linkedin" } },
  });
}

// Fetches userinfo by actually using the saved access token against
// LinkedIn — a fake "connected" state is never produced.
export async function testLinkedInConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "LinkedIn connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as LinkedInCredentialMetadata;
    const { accessToken } = JSON.parse(
      decryptSecret(credential.encryptedSecret),
    ) as { accessToken: string };
    const lastTestResult: NonNullable<
      LinkedInCredentialMetadata["lastTestResult"]
    > = { testedAt: new Date().toISOString() };

    try {
      const profile = await fetchLinkedInProfile(accessToken);
      lastTestResult.displayName = profile.displayName;
    } catch (error) {
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { status: "EXPIRED" },
      });
      lastTestResult.error = describeLinkedInError(error);
    }

    const nextMetadata: LinkedInCredentialMetadata = {
      ...metadata,
      lastTestResult,
    };
    await prisma.integrationCredential.update({
      where: { id: credential.id },
      data: {
        metadata: nextMetadata,
        status: lastTestResult.error ? "EXPIRED" : "ACTIVE",
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

export async function disconnectLinkedInAction(
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
      metadata: { provider: "linkedin" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
