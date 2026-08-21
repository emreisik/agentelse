import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { encryptSecret } from "@/server/security/crypto";
import { verifyOAuthState } from "@/server/security/oauth-state";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  exchangeTikTokAuthCode,
  fetchTikTokProfile,
  serializeTikTokTokens,
  type TikTokCredentialMetadata,
} from "@/server/integrations/tiktok-client";

function redirectToEntegrasyonlar(projectId: string, tiktokError?: string) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", "tiktok");
  if (tiktokError) url.searchParams.set("tiktokError", tiktokError);
  return NextResponse.redirect(url);
}

// The return trip from TikTok's consent screen — exchanges the code
// (together with the PKCE code_verifier) for an access+refresh token pair,
// fetches profile info, and establishes the connection. Same skeleton as
// google/callback and meta/callback.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      appUrl("/dashboard?tiktokError=state_invalid"),
    );
  }

  if (error === "access_denied") {
    return redirectToEntegrasyonlar(state.projectId, "denied");
  }
  if (error) {
    return redirectToEntegrasyonlar(state.projectId, "exchange_failed");
  }
  if (!code || !state.codeVerifier) {
    return redirectToEntegrasyonlar(state.projectId, "exchange_failed");
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return redirectToEntegrasyonlar(state.projectId, "unauthorized");
  }
  if (userId !== state.userId) {
    return redirectToEntegrasyonlar(state.projectId, "state_invalid");
  }

  let access: {
    workspaceId: string;
    projectId: string;
    defaultBrandId: string;
  };
  try {
    access = await requireProjectAccess(userId, state.projectId);
  } catch {
    return redirectToEntegrasyonlar(state.projectId, "state_invalid");
  }

  let tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  try {
    tokens = await exchangeTikTokAuthCode(code, state.codeVerifier);
  } catch {
    return redirectToEntegrasyonlar(state.projectId, "exchange_failed");
  }

  const profile = await fetchTikTokProfile(tokens.accessToken);

  const metadata: TikTokCredentialMetadata = {
    openId: profile?.openId,
    displayName: profile?.displayName,
    avatarUrl: profile?.avatarUrl,
    accessTokenExpiresAt: new Date(
      Date.now() + tokens.expiresIn * 1000,
    ).toISOString(),
  };

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "tiktok" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "tiktok",
      accountLabel: profile?.displayName ?? "TikTok",
      encryptedSecret: encryptSecret(
        serializeTikTokTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }),
      ),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: profile?.displayName ?? "TikTok",
      encryptedSecret: encryptSecret(
        serializeTikTokTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }),
      ),
      metadata,
      status: "ACTIVE",
    },
  });

  await AuditLogRepository.record({
    workspaceId: access.workspaceId,
    projectId: state.projectId,
    actorType: "USER",
    actorId: userId,
    action: "integration_credential.connected",
    entityType: "IntegrationCredential",
    entityId: credential.id,
    metadata: { provider: "tiktok" },
  });

  return redirectToEntegrasyonlar(state.projectId);
}
