import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { isIntegrationConfigured } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { gaFixesEnabledFor } from "@/lib/website-analytics/fixes/flags";
import {
  GOOGLE_PROVIDER,
  buildGoogleAuthorizeUrl,
  parseGoogleService,
} from "@/server/integrations/google-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
} from "@/server/security/pkce";
import {
  isWorkspaceManager,
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The initial step that redirects to Google's own consent screen — see
// callback/route.ts for the return trip. `service` picks which of the two
// separate Google integrations (analytics / search_console) is being
// connected; only that service's scope is requested. `upgrade=edit`
// (analytics only, GA-F7) is the optional second consent that adds
// analytics.edit to an already connected Google Analytics account.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const service = parseGoogleService(searchParams.get("service"));
  if (!projectId || !service) {
    return NextResponse.json(
      { error: "projectId and a valid service are required" },
      { status: 400 },
    );
  }

  // Yalnız "edit" geçerlidir; başka değerler yok sayılır.
  const upgrade = searchParams.get("upgrade") === "edit";
  if (upgrade && service !== "analytics") {
    return NextResponse.json(
      { error: "upgrade=edit is only for analytics" },
      { status: 400 },
    );
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let access: { workspaceId: string };
  try {
    access = await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (!isIntegrationConfigured("GOOGLE")) {
    return NextResponse.redirect(
      appUrl(
        `/projects/${projectId}/integrations?integration=${GOOGLE_PROVIDER[service]}&googleError=not_configured`,
      ),
    );
  }

  let loginHint: string | undefined;
  if (upgrade) {
    const refusal = (code: string) =>
      NextResponse.redirect(
        appUrl(
          `/projects/${projectId}/integrations?integration=${GOOGLE_PROVIDER.analytics}&googleError=${code}`,
        ),
      );
    if (!gaFixesEnabledFor(projectId)) return refusal("edit_not_available");
    if (!(await isWorkspaceManager(userId, access.workspaceId))) {
      return refusal("edit_manager_only");
    }
    // Yükseltme, bağlı ve mülkü seçilmiş bir Analytics bağlantısı ister.
    const credential = await prisma.integrationCredential.findUnique({
      where: {
        projectId_provider: { projectId, provider: GOOGLE_PROVIDER.analytics },
      },
      select: { status: true, encryptedSecret: true, metadata: true },
    });
    const metadata = (credential?.metadata ?? {}) as {
      selectedGa4PropertyId?: unknown;
      connectedEmail?: unknown;
    };
    if (
      !credential ||
      credential.status !== "ACTIVE" ||
      !credential.encryptedSecret ||
      typeof metadata.selectedGa4PropertyId !== "string" ||
      !metadata.selectedGa4PropertyId
    ) {
      return refusal("edit_connect_first");
    }
    if (typeof metadata.connectedEmail === "string" && metadata.connectedEmail) {
      loginHint = metadata.connectedEmail;
    }
  }

  // PKCE: doğrulayıcı imzalı state'te taşınır; state oturum kullanıcısına
  // bağlı olduğu için çalınan bir kod başka bir oturumda kullanılamaz.
  const codeVerifier = generateCodeVerifier();
  const state = signOAuthState({
    projectId,
    userId,
    service,
    codeVerifier,
    ...(upgrade ? { upgrade: "edit" } : {}),
  });
  const challenge = deriveCodeChallenge(codeVerifier);
  return NextResponse.redirect(
    upgrade
      ? buildGoogleAuthorizeUrl(state, service, challenge, {
          upgrade: "edit",
          loginHint,
        })
      : buildGoogleAuthorizeUrl(state, service, challenge),
  );
}
