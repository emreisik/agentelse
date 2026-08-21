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
  exchangeLinkedInAuthCode,
  fetchLinkedInProfile,
  type LinkedInCredentialMetadata,
} from "@/server/integrations/linkedin-client";

function redirectToEntegrasyonlar(projectId: string, linkedinError?: string) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", "linkedin");
  if (linkedinError) url.searchParams.set("linkedinError", linkedinError);
  return NextResponse.redirect(url);
}

// The return trip from LinkedIn's consent screen — exchanges the code for
// an access token, fetches profile info (OpenID Connect userinfo), and
// establishes the connection. Same skeleton as google/callback and
// meta/callback.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      appUrl("/dashboard?linkedinError=state_invalid"),
    );
  }

  if (
    error === "user_cancelled_login" ||
    error === "user_cancelled_authorize"
  ) {
    return redirectToEntegrasyonlar(state.projectId, "denied");
  }
  if (!code) {
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

  let tokens: {
    accessToken: string;
    refreshToken: string | null;
    expiresIn: number;
  };
  try {
    tokens = await exchangeLinkedInAuthCode(code);
  } catch {
    return redirectToEntegrasyonlar(state.projectId, "exchange_failed");
  }

  // A userinfo hiccup (rate limit, transient 500, timeout, ...) must not
  // throw away the tokens we already exchanged — same tolerance as Google's
  // fetchGoogleAccountEmail / Meta's fetchMetaAccountName / the sibling
  // TikTok/X callbacks, all of which upsert the credential regardless of
  // whether the profile fetch succeeded. memberUrn ends up undefined in that
  // case; LinkedInApiProvider already handles that gracefully at publish
  // time ("LinkedIn member urn is missing"), and testLinkedInConnectionAction
  // can backfill it on a later retry.
  const profile = await fetchLinkedInProfile(tokens.accessToken).catch(
    () => null,
  );

  const metadata: LinkedInCredentialMetadata = {
    memberUrn: profile?.memberUrn,
    displayName: profile?.displayName,
    avatarUrl: profile?.avatarUrl,
    accessTokenExpiresAt: new Date(
      Date.now() + tokens.expiresIn * 1000,
    ).toISOString(),
    hasRefreshToken: Boolean(tokens.refreshToken),
  };

  // If there's no refresh token (product approval not granted), only the
  // access token is stored — once testLinkedInConnectionAction/callback
  // flips this to EXPIRED, the user has to reconnect (same as Meta's
  // long-lived token).
  const secretPayload = tokens.refreshToken
    ? JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      })
    : JSON.stringify({ accessToken: tokens.accessToken });

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "linkedin" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "linkedin",
      accountLabel: profile?.displayName ?? "LinkedIn",
      encryptedSecret: encryptSecret(secretPayload),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: profile?.displayName ?? "LinkedIn",
      encryptedSecret: encryptSecret(secretPayload),
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
    metadata: { provider: "linkedin" },
  });

  return redirectToEntegrasyonlar(state.projectId);
}
