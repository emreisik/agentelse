import { AdsAccounts } from "@/server/ads/accounts";
import { checkCredentialToken } from "@/server/ads/token-health";
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
  InstagramPendingTesterError,
  META_PROVIDER,
  META_SERVICE_LABEL,
  MetaApiError,
  exchangeForLongLivedToken,
  exchangeInstagramAuthCode,
  exchangeInstagramLongLivedToken,
  exchangeMetaAuthCode,
  fetchInstagramLoginProfile,
  fetchMetaUserIdentity,
  fetchMetaAdAccountList,
  fetchMetaPageList,
  parseMetaService,
  reconcileAdAccountSelection,
  reconcilePageSelection,
  type MetaAdsMetadata,
  type MetaFacebookMetadata,
  type MetaInstagramMetadata,
  type MetaService,
} from "@/server/integrations/meta-client";

function redirectToIntegrations(
  projectId: string,
  service: MetaService,
  metaError?: string,
  detail?: string,
) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", META_PROVIDER[service]);
  if (metaError) url.searchParams.set("metaError", metaError);
  // What Meta itself said (its error text, never a token), so a failed exchange
  // can be diagnosed from the page instead of from a silent redirect.
  if (detail) url.searchParams.set("metaDetail", detail.slice(0, 200));
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
): Promise<MetaInstagramMetadata | MetaFacebookMetadata | MetaAdsMetadata> {
  if (service === "facebook") {
    // Facebook keeps its own Page selection: nothing is read from, or written
    // to, the Instagram or Meta Ads rows.
    const previous = existing as Partial<MetaFacebookMetadata>;
    const pages = await fetchMetaPageList(accessToken, {
      onlyWithInstagram: false,
    });
    return {
      ...previous,
      ...connection,
      ...pages,
      ...reconcilePageSelection(previous, pages.pages),
    };
  }
  if (service === "instagram") {
    // Facebook route. A previous Instagram Login connection's keys must not carry
    // over: resolveInstagramTarget puts them ahead of the Page, which would pair this
    // Facebook token with Instagram's host and the old account.
    const previous: Partial<MetaInstagramMetadata> = {
      ...(existing as Partial<MetaInstagramMetadata>),
    };
    // Its last test result names the old account too (IG: @old): drop it as well.
    if (previous.login === "instagram") delete previous.lastTestResult;
    delete previous.login;
    delete previous.instagramAccount;
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

// Instagram's own account types: only these can publish through the API. A
// personal account cannot, and Instagram says so on its consent screen.
const PROFESSIONAL_ACCOUNT_TYPES = ["BUSINESS", "MEDIA_CREATOR", "CREATOR"];

// Return from Meta's consent screen — exchanges the code for a long-lived
// token, lists what the service needs (Pages with a linked Instagram
// Business account, every managed Page for Facebook, or ad accounts + Pages) and establishes that service's
// connection. Same skeleton as google/callback/route.ts. A grant made through
// Instagram Login (state.login === "instagram") skips the Page list: the
// account itself is the connection.
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

  const viaInstagram = service === "instagram" && state.login === "instagram";

  let longLivedToken: { accessToken: string; expiresIn: number };
  let instagramProfile:
    | Awaited<ReturnType<typeof fetchInstagramLoginProfile>>
    | undefined;
  let instagramAuthUserId: string | undefined;
  let step = "code exchange";
  try {
    if (viaInstagram) {
      const shortLived = await exchangeInstagramAuthCode(code);
      instagramAuthUserId = shortLived.userId;
      step = "long-lived token";
      longLivedToken = await exchangeInstagramLongLivedToken(
        shortLived.accessToken,
      );
      step = "account profile";
      instagramProfile = await fetchInstagramLoginProfile(
        longLivedToken.accessToken,
      );
    } else {
      const shortLived = await exchangeMetaAuthCode(code);
      step = "long-lived token";
      longLivedToken = await exchangeForLongLivedToken(shortLived.accessToken);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[meta-callback] ${viaInstagram ? "instagram-login" : "facebook"} connection failed at "${step}":`,
      reason,
      error instanceof MetaApiError
        ? { code: error.metaErrorCode, subcode: error.metaErrorSubcode }
        : "",
    );
    if (error instanceof InstagramPendingTesterError) {
      return redirectToIntegrations(state.projectId, service, "pending_tester");
    }
    return redirectToIntegrations(
      state.projectId,
      service,
      "exchange_failed",
      `${step}: ${reason}`,
    );
  }
  if (
    instagramProfile?.accountType &&
    !PROFESSIONAL_ACCOUNT_TYPES.includes(instagramProfile.accountType)
  ) {
    return redirectToIntegrations(state.projectId, service, "not_professional");
  }

  const provider = META_PROVIDER[service];
  const existing = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId: state.projectId, provider } },
  });

  // Even if a list fails (e.g. permission wasn't granted for that Page), the
  // connection is still established — the error message is stored in the
  // metadata and shown in the dialog.
  // Facebook route: the person's app-scoped id is kept with the name. Meta's
  // deauthorize / data-deletion requests name the person by it, and
  // Disconnect revokes the ads permissions on it (docs/meta-ads-plan.md F1).
  const facebookIdentity = instagramProfile
    ? null
    : await fetchMetaUserIdentity(longLivedToken.accessToken);
  const connectedName = instagramProfile
    ? instagramProfile.username
      ? `@${instagramProfile.username}`
      : null
    : (facebookIdentity?.name ?? null);
  const connection = {
    connectedName: connectedName ?? undefined,
    longLivedTokenExpiresAt: new Date(
      Date.now() + longLivedToken.expiresIn * 1000,
    ).toISOString(),
    ...(facebookIdentity?.id ? { appScopedUserId: facebookIdentity.id } : {}),
  };
  // A fresh Instagram Login row replaces whatever a previous Facebook-route
  // connection held (its Page list and selection mean nothing here).
  const metadata:
    | MetaInstagramMetadata
    | MetaFacebookMetadata
    | MetaAdsMetadata = instagramProfile
    ? {
        ...connection,
        login: "instagram",
        instagramAccount: {
          id: instagramProfile.id,
          appScopedId: instagramProfile.appScopedId ?? instagramAuthUserId,
          username: instagramProfile.username,
          accountType: instagramProfile.accountType,
        },
        pages: [],
      }
    : await buildMetadata(
        service,
        longLivedToken.accessToken,
        connection,
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

  // The token is checked once right away (validity, expiry, granted scopes):
  // the tile shows a missing permission at once, not a day later. Meta Ads
  // also gets its account row (src/server/ads/accounts.ts). Neither can fail
  // the connection.
  if (!instagramProfile) {
    await checkCredentialToken(credential).catch(() => null);
  }
  if (service === "ads") {
    await AdsAccounts.resolve(state.projectId).catch(() => null);
  }

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
