"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { decryptSecret, encryptSecret } from "@/server/security/crypto";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  XApiError,
  fetchXProfile,
  parseXTokens,
  refreshXAccessToken,
  serializeXTokens,
  type XCredentialMetadata,
} from "@/server/integrations/x-client";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeXError(error: unknown): string {
  if (!(error instanceof XApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  return `X: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeXError(error) };
}

function loadCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "x" } },
  });
}

// Fetches profile info by actually using the saved refresh token against
// X — a fake "connected" state is never produced.
export async function testXConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "X connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as XCredentialMetadata;
    const tokens = parseXTokens(decryptSecret(credential.encryptedSecret));
    const lastTestResult: NonNullable<XCredentialMetadata["lastTestResult"]> = {
      testedAt: new Date().toISOString(),
    };

    try {
      let accessToken = tokens.accessToken;
      let profile = await fetchXProfile(accessToken);
      if (!profile) {
        const refreshed = await refreshXAccessToken(tokens.refreshToken);
        accessToken = refreshed.accessToken;
        profile = await fetchXProfile(accessToken);
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: {
            encryptedSecret: encryptSecret(
              serializeXTokens({
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
              }),
            ),
          },
        });
      }
      if (!profile) {
        throw new XApiError("Failed to fetch profile info");
      }
      lastTestResult.username = profile.username;
    } catch (error) {
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { status: "EXPIRED" },
      });
      lastTestResult.error = describeXError(error);
    }

    const nextMetadata: XCredentialMetadata = { ...metadata, lastTestResult };
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

export async function disconnectXAction(
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
      metadata: { provider: "x" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
