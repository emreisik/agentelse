import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import { gaFixesEnabledFor } from "@/lib/website-analytics/fixes/flags";
import { buildGaEditGrant } from "@/lib/website-analytics/fixes/edit-grant";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { encryptSecret } from "@/server/security/crypto";
import { verifyOAuthState } from "@/server/security/oauth-state";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";
import {
  GOOGLE_PROVIDER,
  GOOGLE_SERVICE_LABEL,
  exchangeGoogleAuthCode,
  parseGoogleService,
  type GoogleService,
} from "@/server/integrations/google-client";
import { buildGoogleConnectionMetadata } from "@/server/integrations/google-connection-metadata";
import { fetchGoogleIdentity } from "@/server/integrations/google/oauth";
import { forgetGoogleAccessTokens } from "@/server/integrations/google/access-token";
import {
  GOOGLE_SERVICE_SCOPE,
  hasGaEditScope,
  hasServiceScope,
} from "@/server/integrations/google/services";
import { markGaEditGranted } from "@/server/website-analytics/fixes/edit-grant";

function redirectToIntegrations(
  projectId: string,
  service: GoogleService,
  googleError?: string,
  extra?: Record<string, string>,
) {
  const url = appUrl(`/projects/${projectId}/integrations`);
  url.searchParams.set("integration", GOOGLE_PROVIDER[service]);
  if (googleError) url.searchParams.set("googleError", googleError);
  for (const [key, value] of Object.entries(extra ?? {})) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

// Search Console'un salt okunur izni: yükseltme token'ında bulunmamalı.
const SEARCH_CONSOLE_SCOPE = GOOGLE_SERVICE_SCOPE.search_console;

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

  // Yükseltmede bayrak ve rol, kod değişiminden önce de sınanır.
  if (state.upgrade === "edit") {
    const refusal = await editUpgradeRefusal(
      userId,
      state.projectId,
      access.workspaceId,
      service,
    );
    if (refusal) return redirectToIntegrations(state.projectId, service, refusal);
  }

  let tokens: Awaited<ReturnType<typeof exchangeGoogleAuthCode>>;
  try {
    tokens = await exchangeGoogleAuthCode(code, state.codeVerifier);
  } catch {
    return redirectToIntegrations(state.projectId, service, "exchange_failed");
  }

  // İsteğe bağlı ikinci onay (GA-F7): genel izin ve refresh token denetimlerinden
  // ÖNCE ayrı dalda işlenir; başarısızlıkta eski token olduğu gibi kalır ve
  // hiçbir token iptal edilmez (Google iptali Cloud projesi düzeyindedir).
  if (state.upgrade === "edit") {
    return handleEditUpgrade({
      userId,
      projectId: state.projectId,
      workspaceId: access.workspaceId,
      service,
      tokens,
    });
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
  const metadata = await buildGoogleConnectionMetadata(
    service,
    tokens.accessToken,
    {
      connectedEmail: identity.email ?? undefined,
      googleSub: identity.googleSub ?? undefined,
    },
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

async function editUpgradeRefusal(
  userId: string,
  projectId: string,
  workspaceId: string,
  service: GoogleService,
): Promise<"edit_not_available" | "edit_manager_only" | null> {
  if (service !== "analytics" || !gaFixesEnabledFor(projectId)) {
    return "edit_not_available";
  }
  if (!(await isWorkspaceManager(userId, workspaceId))) {
    return "edit_manager_only";
  }
  return null;
}

async function handleEditUpgrade(input: {
  userId: string;
  projectId: string;
  workspaceId: string;
  service: GoogleService;
  tokens: Awaited<ReturnType<typeof exchangeGoogleAuthCode>>;
}) {
  // Bayrak ve rol kod değişiminden önce sınandı (editUpgradeRefusal).
  const { userId, projectId, workspaceId, service, tokens } = input;
  // İki izin de verilmiş olmalı; kullanıcı kutuyu kaldırdıysa hiçbir şey
  // yazılmaz.
  if (
    !hasServiceScope("analytics", tokens.grantedScopes) ||
    !hasGaEditScope(tokens.grantedScopes)
  ) {
    return redirectToIntegrations(projectId, service, "edit_scope_missing");
  }
  // İstenenden geniş token reddedilir: Search Console izni taşıyan bir GA
  // token'ı iki entegrasyonu sessizce birleştirirdi.
  if (tokens.grantedScopes.includes(SEARCH_CONSOLE_SCOPE)) {
    return redirectToIntegrations(projectId, service, "edit_not_available");
  }
  if (!tokens.refreshToken) {
    return redirectToIntegrations(projectId, service, "no_refresh_token");
  }

  const provider = GOOGLE_PROVIDER[service];
  const credential = await prisma.integrationCredential.findUnique({
    where: { projectId_provider: { projectId, provider } },
  });
  const metadata = (credential?.metadata ?? {}) as {
    selectedGa4PropertyId?: unknown;
    googleSub?: unknown;
    connectedEmail?: unknown;
  };
  if (
    !credential ||
    credential.status !== "ACTIVE" ||
    typeof metadata.selectedGa4PropertyId !== "string" ||
    !metadata.selectedGa4PropertyId
  ) {
    return redirectToIntegrations(projectId, service, "edit_connect_first");
  }

  // Aynı Google hesabı şart: önce hesap kimliği, o yoksa e-posta.
  const identity = await fetchGoogleIdentity(tokens.accessToken);
  const knownSub =
    typeof metadata.googleSub === "string" ? metadata.googleSub : null;
  const knownEmail =
    typeof metadata.connectedEmail === "string"
      ? metadata.connectedEmail.toLowerCase()
      : null;
  const sameAccount =
    knownSub && identity.googleSub
      ? knownSub === identity.googleSub
      : knownEmail && identity.email
        ? knownEmail === identity.email.toLowerCase()
        : false;
  if (!sameAccount) {
    return redirectToIntegrations(projectId, service, "edit_account_mismatch");
  }

  // Yalnız token değişir: mülk seçimi ve diğer metadata dokunulmaz.
  await prisma.integrationCredential.update({
    where: { id: credential.id },
    data: {
      encryptedSecret: encryptSecret(tokens.refreshToken),
      status: "ACTIVE",
    },
  });
  await markGaEditGranted(credential.id, buildGaEditGrant(userId));
  forgetGoogleAccessTokens(credential.id);

  await AuditLogRepository.record({
    workspaceId,
    projectId,
    actorType: "USER",
    actorId: userId,
    action: "integration_credential.edit_access_granted",
    entityType: "IntegrationCredential",
    entityId: credential.id,
    metadata: { provider },
  });

  return redirectToIntegrations(projectId, service, undefined, {
    googleEdit: "granted",
  });
}
