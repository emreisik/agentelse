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
  exchangeXAuthCode,
  fetchXProfile,
  serializeXTokens,
  type XCredentialMetadata,
} from "@/server/integrations/x-client";

function redirectToEntegrasyonlar(projectId: string, xError?: string) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", "x");
  if (xError) url.searchParams.set("xError", xError);
  return NextResponse.redirect(url);
}

// The return trip from X's consent screen — exchanges the code (together
// with the PKCE code_verifier) for an access+refresh token pair, fetches
// profile info, and establishes the connection. Same skeleton as
// tiktok/callback.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(appUrl("/dashboard?xError=state_invalid"));
  }

  if (error === "access_denied") {
    return redirectToEntegrasyonlar(state.projectId, "denied");
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
    tokens = await exchangeXAuthCode(code, state.codeVerifier);
  } catch {
    return redirectToEntegrasyonlar(state.projectId, "exchange_failed");
  }

  const profile = await fetchXProfile(tokens.accessToken);

  const metadata: XCredentialMetadata = {
    userId: profile?.userId,
    username: profile?.username,
    displayName: profile?.displayName,
    accessTokenExpiresAt: new Date(
      Date.now() + tokens.expiresIn * 1000,
    ).toISOString(),
  };

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "x" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "x",
      accountLabel: profile?.username ? `@${profile.username}` : "X",
      encryptedSecret: encryptSecret(
        serializeXTokens({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        }),
      ),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: profile?.username ? `@${profile.username}` : "X",
      encryptedSecret: encryptSecret(
        serializeXTokens({
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
    metadata: { provider: "x" },
  });

  return redirectToEntegrasyonlar(state.projectId);
}
