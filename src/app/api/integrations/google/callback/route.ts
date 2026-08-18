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
  exchangeGoogleAuthCode,
  fetchGoogleAccountEmail,
  fetchGoogleLists,
  reconcileGoogleSelection,
  type GoogleCredentialMetadata,
} from "@/server/integrations/google-client";

function redirectToEntegrasyonlar(
  request: Request,
  projectId: string,
  googleError?: string,
) {
  const url = new URL(`/projects/${projectId}/integrations`, request.url);
  url.searchParams.set("integration", "google");
  if (googleError) url.searchParams.set("googleError", googleError);
  return NextResponse.redirect(url);
}

// Return from Google's consent screen — exchanges the code for a token,
// lists accessible GA4 properties + Search Console sites, and establishes
// the connection. Except for the one case where we don't know the
// projectId (when the state can't be verified), all errors redirect back
// to the integrations page.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      new URL("/dashboard?googleError=state_invalid", request.url),
    );
  }

  if (error === "access_denied") {
    return redirectToEntegrasyonlar(request, state.projectId, "denied");
  }
  if (!code) {
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
  // The signed state carries which user initiated the flow — we don't
  // proceed if the current session belongs to a different user (e.g. the
  // connection link was shared).
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

  let tokens: Awaited<ReturnType<typeof exchangeGoogleAuthCode>>;
  try {
    tokens = await exchangeGoogleAuthCode(code);
  } catch {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }
  if (!tokens.refreshToken) {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "no_refresh_token",
    );
  }

  // Even if one of the property/site lists fails (e.g. that API isn't
  // enabled on the GCP project), the connection is still established — the
  // error message is stored in the metadata and shown in the dialog.
  const [connectedEmail, lists] = await Promise.all([
    fetchGoogleAccountEmail(tokens.accessToken),
    fetchGoogleLists(tokens.accessToken),
  ]);

  const existing = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "google" },
    },
  });
  const existingMetadata = (existing?.metadata ??
    {}) as GoogleCredentialMetadata;

  const metadata: GoogleCredentialMetadata = {
    connectedEmail: connectedEmail ?? undefined,
    ...lists,
    ...reconcileGoogleSelection(existingMetadata, lists),
  };

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "google" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "google",
      accountLabel: connectedEmail ?? "Google",
      encryptedSecret: encryptSecret(tokens.refreshToken),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: connectedEmail ?? "Google",
      encryptedSecret: encryptSecret(tokens.refreshToken),
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
    metadata: { provider: "google" },
  });

  return redirectToEntegrasyonlar(request, state.projectId);
}
