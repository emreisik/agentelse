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
  exchangeForLongLivedToken,
  exchangeMetaAuthCode,
  fetchMetaAccountName,
  listAdAccounts,
  listManagedPages,
  type MetaCredentialMetadata,
} from "@/server/integrations/meta-client";

type ListOutcome<T> = { items: T[]; error?: string };

async function safeList<T>(
  promise: Promise<T[]>,
  fallbackMessage: string,
): Promise<ListOutcome<T>> {
  try {
    return { items: await promise };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : fallbackMessage,
    };
  }
}

function redirectToEntegrasyonlar(
  request: Request,
  projectId: string,
  metaError?: string,
) {
  const url = new URL(`/projects/${projectId}/integrations`, request.url);
  url.searchParams.set("integration", "meta");
  if (metaError) url.searchParams.set("metaError", metaError);
  return NextResponse.redirect(url);
}

// Return from Meta's consent screen — exchanges the code for a long-lived
// token, lists managed Pages (along with their linked Instagram Business
// accounts) and ad accounts, and establishes the connection. Same skeleton
// as google/callback/route.ts.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  if (!state) {
    return NextResponse.redirect(
      new URL("/dashboard?metaError=state_invalid", request.url),
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
  // proceed if the current session belongs to a different user.
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

  let longLivedToken: { accessToken: string; expiresIn: number };
  try {
    const shortLived = await exchangeMetaAuthCode(code);
    longLivedToken = await exchangeForLongLivedToken(shortLived.accessToken);
  } catch {
    return redirectToEntegrasyonlar(
      request,
      state.projectId,
      "exchange_failed",
    );
  }

  // Even if one of the Page/ad account lists fails (e.g. permission wasn't
  // granted for that Page), the connection is still established — the error
  // message is stored in the metadata and shown in the dialog.
  const [connectedName, pages, adAccounts] = await Promise.all([
    fetchMetaAccountName(longLivedToken.accessToken),
    safeList(
      listManagedPages(longLivedToken.accessToken),
      "Failed to fetch Page list",
    ),
    safeList(
      listAdAccounts(longLivedToken.accessToken),
      "Failed to fetch ad account list",
    ),
  ]);

  const existing = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "meta" },
    },
  });
  const existingMetadata = (existing?.metadata ?? {}) as MetaCredentialMetadata;

  const keepPageSelection =
    existingMetadata.selectedPageId &&
    pages.items.some((p) => p.pageId === existingMetadata.selectedPageId);
  const keepAdAccountSelection =
    existingMetadata.selectedAdAccountId &&
    adAccounts.items.some(
      (a) => a.adAccountId === existingMetadata.selectedAdAccountId,
    );

  const metadata: MetaCredentialMetadata = {
    connectedName: connectedName ?? undefined,
    longLivedTokenExpiresAt: new Date(
      Date.now() + longLivedToken.expiresIn * 1000,
    ).toISOString(),
    pages: pages.items,
    pagesListError: pages.error,
    adAccounts: adAccounts.items,
    adAccountsListError: adAccounts.error,
    selectedPageId: keepPageSelection
      ? existingMetadata.selectedPageId
      : undefined,
    selectedPageName: keepPageSelection
      ? existingMetadata.selectedPageName
      : undefined,
    selectedAdAccountId: keepAdAccountSelection
      ? existingMetadata.selectedAdAccountId
      : undefined,
    selectedAdAccountName: keepAdAccountSelection
      ? existingMetadata.selectedAdAccountName
      : undefined,
  };

  const credential = await prisma.integrationCredential.upsert({
    where: {
      projectId_provider: { projectId: state.projectId, provider: "meta" },
    },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider: "meta",
      accountLabel: connectedName ?? "Meta",
      encryptedSecret: encryptSecret(longLivedToken.accessToken),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel: connectedName ?? "Meta",
      encryptedSecret: encryptSecret(longLivedToken.accessToken),
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
    metadata: { provider: "meta" },
  });

  return redirectToEntegrasyonlar(request, state.projectId);
}
