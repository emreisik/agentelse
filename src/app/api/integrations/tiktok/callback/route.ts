import { NextResponse } from "next/server";

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

function redirectToEntegrasyonlar(
  request: Request,
  projectId: string,
  tiktokError?: string,
) {
  const url = new URL(`/projects/${projectId}/integrations`, request.url);
  url.searchParams.set("integration", "tiktok");
  if (tiktokError) url.searchParams.set("tiktokError", tiktokError);
  return NextResponse.redirect(url);
}

// TikTok'un consent ekranından dönüş — code'u (PKCE code_verifier ile
// birlikte) access+refresh token çiftine çevirir, profil bilgisini çeker,
// bağlantıyı kurar. google/callback ve meta/callback ile aynı iskelet.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      new URL("/dashboard?tiktokError=state_invalid", request.url),
    );
  }

  if (error === "access_denied") {
    return redirectToEntegrasyonlar(request, state.projectId, "denied");
  }
  if (error) {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }
  if (!code || !state.codeVerifier) {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return redirectToEntegrasyonlar(request, state.projectId, "unauthorized");
  }
  if (userId !== state.userId) {
    return redirectToEntegrasyonlar(request, state.projectId, "state_invalid");
  }

  let access: {
    workspaceId: string;
    projectId: string;
    defaultBrandId: string;
  };
  try {
    access = await requireProjectAccess(userId, state.projectId);
  } catch {
    return redirectToEntegrasyonlar(request, state.projectId, "state_invalid");
  }

  let tokens: { accessToken: string; refreshToken: string; expiresIn: number };
  try {
    tokens = await exchangeTikTokAuthCode(code, state.codeVerifier);
  } catch {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
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

  return redirectToEntegrasyonlar(request, state.projectId);
}
