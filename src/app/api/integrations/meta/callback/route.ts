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
  META_PROVIDER,
  META_SERVICE_LABEL,
  exchangeForLongLivedToken,
  exchangeMetaAuthCode,
  fetchMetaAccountName,
  fetchMetaAdAccountList,
  fetchMetaPageList,
  parseMetaService,
  reconcileAdAccountSelection,
  reconcilePageSelection,
  type MetaAdsMetadata,
  type MetaInstagramMetadata,
  type MetaService,
} from "@/server/integrations/meta-client";

function redirectToIntegrations(
  projectId: string,
  service: MetaService,
  metaError?: string,
) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", META_PROVIDER[service]);
  if (metaError) url.searchParams.set("metaError", metaError);
  return NextResponse.redirect(url);
}

// Builds the service's metadata from fresh list fetches, keeping previous
// selections that are still accessible. Scan bookkeeping and snapshots from
// the existing row are carried over so a reconnect doesn't reset the
// scanner.
async function buildMetadata(
  service: MetaService,
  accessToken: string,
  connection: { connectedName?: string; longLivedTokenExpiresAt: string },
  existing: Record<string, unknown>,
): Promise<MetaInstagramMetadata | MetaAdsMetadata> {
  if (service === "instagram") {
    const previous = existing as Partial<MetaInstagramMetadata>;
    const pages = await fetchMetaPageList(accessToken, {
      onlyWithInstagram: true,
    });
    return {
      ...previous,
      ...connection,
      ...pages,
      ...reconcilePageSelection(previous, pages.pages),
    };
  }
  const previous = existing as Partial<MetaAdsMetadata>;
  const [pages, adAccounts] = await Promise.all([
    fetchMetaPageList(accessToken, { onlyWithInstagram: false }),
    fetchMetaAdAccountList(accessToken),
  ]);
  return {
    ...previous,
    ...connection,
    ...pages,
    ...adAccounts,
    ...reconcilePageSelection(previous, pages.pages),
    ...reconcileAdAccountSelection(previous, adAccounts.adAccounts),
  };
}

// Return from Meta's consent screen — exchanges the code for a long-lived
// token, lists what the service needs (Pages with a linked Instagram
// Business account, or ad accounts + Pages) and establishes that service's
// connection. Same skeleton as google/callback/route.ts.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  const service = parseMetaService(state?.service);
  if (!state || !service) {
    return NextResponse.redirect(appUrl("/dashboard?metaError=state_invalid"));
  }

  if (error === "access_denied") {
    return redirectToIntegrations(state.projectId, service, "denied");
  }
  if (!code) {
    return redirectToIntegrations(state.projectId, service, "exchange_failed");
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return redirectToIntegrations(state.projectId, service, "unauthorized");
  }
  // The signed state carries which user initiated the flow — we don't
  // proceed if the current session belongs to a different user.
  if (userId !== state.userId) {
    return redirectToIntegrations(state.projectId, service, "state_invalid");
  }

  let access: {
    workspaceId: string;
    projectId: string;
    defaultBrandId: string;
  };
  try {
    access = await requireProjectAccess(userId, state.projectId);
  } catch {
    return redirectToIntegrations(state.projectId, service, "state_invalid");
  }

  let longLivedToken: { accessToken: string; expiresIn: number };
  try {
    const shortLived = await exchangeMetaAuthCode(code);
    longLivedToken = await exchangeForLongLivedToken(shortLived.accessToken);
  } catch {
    return redirectToIntegrations(state.projectId, service, "exchange_failed");
  }

  const provider = META_PROVIDER[service];
  const existing = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId: state.projectId, provider } },
  });

  // Even if a list fails (e.g. permission wasn't granted for that Page), the
  // connection is still established — the error message is stored in the
  // metadata and shown in the dialog.
  const connectedName = await fetchMetaAccountName(longLivedToken.accessToken);
  const metadata = await buildMetadata(
    service,
    longLivedToken.accessToken,
    {
      connectedName: connectedName ?? undefined,
      longLivedTokenExpiresAt: new Date(
        Date.now() + longLivedToken.expiresIn * 1000,
      ).toISOString(),
    },
    (existing?.metadata ?? {}) as Record<string, unknown>,
  );
  const accountLabel = connectedName ?? META_SERVICE_LABEL[service];

  const credential = await prisma.integrationCredential.upsert({
    where: { projectId_provider: { projectId: state.projectId, provider } },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider,
      accountLabel,
      encryptedSecret: encryptSecret(longLivedToken.accessToken),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel,
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
    metadata: { provider },
  });

  return redirectToIntegrations(state.projectId, service);
}
