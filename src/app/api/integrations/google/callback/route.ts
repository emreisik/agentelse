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
  GOOGLE_PROVIDER,
  GOOGLE_SERVICE_LABEL,
  exchangeGoogleAuthCode,
  fetchGa4PropertyList,
  fetchSearchConsoleSiteList,
  parseGoogleService,
  reconcileGa4Selection,
  reconcileSearchConsoleSelection,
  type GoogleAnalyticsMetadata,
  type GoogleSearchConsoleMetadata,
  type GoogleService,
} from "@/server/integrations/google-client";
import {
  fetchGoogleIdentity,
  type GoogleIdentity,
} from "@/server/integrations/google/oauth";
import { hasServiceScope } from "@/server/integrations/google/services";

function redirectToIntegrations(
  projectId: string,
  service: GoogleService,
  googleError?: string,
) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", GOOGLE_PROVIDER[service]);
  if (googleError) url.searchParams.set("googleError", googleError);
  return NextResponse.redirect(url);
}

// Builds the service's metadata from a fresh list fetch, keeping the
// previous selection if it's still accessible. Scan bookkeeping from the
// existing row is carried over so a reconnect doesn't reset the scanner.
// Koparılmış bir satırın `disconnectedAt` işareti yeniden bağlanınca düşer.
async function buildMetadata(
  service: GoogleService,
  accessToken: string,
  identity: GoogleIdentity,
  existing: Record<string, unknown>,
): Promise<GoogleAnalyticsMetadata | GoogleSearchConsoleMetadata> {
  const kept: Record<string, unknown> = { ...existing };
  delete kept.disconnectedAt;
  const account = {
    connectedEmail: identity.email ?? undefined,
    googleSub: identity.googleSub ?? undefined,
  };
  if (service === "analytics") {
    const previous = kept as Partial<GoogleAnalyticsMetadata>;
    const lists = await fetchGa4PropertyList(accessToken);
    return {
      ...previous,
      ...account,
      ga4ListError: undefined,
      ...lists,
      ...reconcileGa4Selection(previous, lists),
    };
  }
  const previous = kept as Partial<GoogleSearchConsoleMetadata>;
  const lists = await fetchSearchConsoleSiteList(accessToken);
  return {
    ...previous,
    ...account,
    gscListError: undefined,
    ...lists,
    ...reconcileSearchConsoleSelection(previous, lists),
  };
}

// Return from Google's consent screen — exchanges the code for a token,
// lists the service's accessible GA4 properties or Search Console sites,
// and establishes that service's connection. Except for the one case where
// we don't know the projectId/service (when the state can't be verified),
// all errors redirect back to the integrations page.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const stateParam = searchParams.get("state");

  const state = stateParam ? verifyOAuthState(stateParam) : null;
  const service = parseGoogleService(state?.service);
  if (!state || !service) {
    return NextResponse.redirect(
      appUrl("/dashboard?googleError=state_invalid"),
    );
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
  // proceed if the current session belongs to a different user (e.g. the
  // connection link was shared).
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

  let tokens: Awaited<ReturnType<typeof exchangeGoogleAuthCode>>;
  try {
    tokens = await exchangeGoogleAuthCode(code, state.codeVerifier);
  } catch {
    return redirectToIntegrations(state.projectId, service, "exchange_failed");
  }
  // Google, e-posta + bir veri izni istendiğinde onay kutuları gösterir;
  // kullanıcı veri iznini kaldırdıysa bağlantı kurulmaz (yoksa "Connected"
  // görünüp her çağrı 403 alırdı). Token iptal edilmez: Google iptali Cloud
  // projesi düzeyinde uyguladığı için aynı hesabın diğer Agentelse
  // bağlantısını da koparırdı. Yanıtta `scope` hiç yoksa (beklenmez) karar
  // verilemez ve bağlantı kurulur; ilk API çağrısı izni yine sınar.
  if (
    tokens.grantedScopes.length > 0 &&
    !hasServiceScope(service, tokens.grantedScopes)
  ) {
    return redirectToIntegrations(state.projectId, service, "scope_missing");
  }
  if (!tokens.refreshToken) {
    return redirectToIntegrations(state.projectId, service, "no_refresh_token");
  }

  const provider = GOOGLE_PROVIDER[service];
  const existing = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId: state.projectId, provider } },
  });

  // Even if the property/site list fails (e.g. that API isn't enabled on
  // the GCP project), the connection is still established — the error
  // message is stored in the metadata and shown in the dialog.
  const identity = await fetchGoogleIdentity(tokens.accessToken);
  const metadata = await buildMetadata(
    service,
    tokens.accessToken,
    identity,
    (existing?.metadata ?? {}) as Record<string, unknown>,
  );
  const accountLabel = identity.email ?? GOOGLE_SERVICE_LABEL[service];

  const credential = await prisma.integrationCredential.upsert({
    where: { projectId_provider: { projectId: state.projectId, provider } },
    create: {
      workspaceId: access.workspaceId,
      projectId: state.projectId,
      brandId: access.defaultBrandId,
      provider,
      accountLabel,
      encryptedSecret: encryptSecret(tokens.refreshToken),
      metadata,
      status: "ACTIVE",
    },
    update: {
      accountLabel,
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
    metadata: { provider },
  });

  return redirectToIntegrations(state.projectId, service);
}
