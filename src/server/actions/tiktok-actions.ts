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
  TikTokApiError,
  fetchTikTokProfile,
  parseTikTokTokens,
  refreshTikTokAccessToken,
  serializeTikTokTokens,
  type TikTokCredentialMetadata,
} from "@/server/integrations/tiktok-client";

export type ActionResult = { ok: true } | { ok: false; message: string };

function describeTikTokError(error: unknown): string {
  if (!(error instanceof TikTokApiError)) {
    return error instanceof Error ? error.message : "Operation failed";
  }
  return `TikTok: ${error.message}`;
}

function fail(error: unknown): ActionResult {
  return { ok: false, message: describeTikTokError(error) };
}

function loadCredential(projectId: string) {
  return prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider: "tiktok" } },
  });
}

// Fetches profile info by actually using the saved refresh token against
// TikTok — a fake "connected" state is never produced. If the token has
// expired/been revoked, it first tries to refresh (unlike Meta, TikTok
// provides an auto-renewable refresh token).
export async function testTikTokConnectionAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const projectId = String(formData.get("projectId"));
    const { userId } = await requireUser();
    await requireProjectAccess(userId, projectId);

    const credential = await loadCredential(projectId);
    if (!credential) {
      return { ok: false, message: "TikTok connection not found" };
    }

    const metadata = (credential.metadata ?? {}) as TikTokCredentialMetadata;
    const tokens = parseTikTokTokens(decryptSecret(credential.encryptedSecret));
    const lastTestResult: NonNullable<
      TikTokCredentialMetadata["lastTestResult"]
    > = { testedAt: new Date().toISOString() };

    try {
      let accessToken = tokens.accessToken;
      let profile = await fetchTikTokProfile(accessToken);
      if (!profile) {
        // The access token may have expired — try to refresh it.
        const refreshed = await refreshTikTokAccessToken(tokens.refreshToken);
        accessToken = refreshed.accessToken;
        profile = await fetchTikTokProfile(accessToken);
        await prisma.integrationCredential.update({
          where: { id: credential.id },
          data: {
            encryptedSecret: encryptSecret(
              serializeTikTokTokens({
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
              }),
            ),
          },
        });
      }
      if (!profile) {
        throw new TikTokApiError("Failed to fetch profile info");
      }
      lastTestResult.displayName = profile.displayName;
    } catch (error) {
      await prisma.integrationCredential.update({
        where: { id: credential.id },
        data: { status: "EXPIRED" },
      });
      lastTestResult.error = describeTikTokError(error);
    }

    const nextMetadata: TikTokCredentialMetadata = {
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

export async function disconnectTikTokAction(
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
      metadata: { provider: "tiktok" },
    });

    revalidatePath(`/projects/${projectId}/integrations`);
    return { ok: true };
  } catch (error) {
    return fail(error);
  }
}
