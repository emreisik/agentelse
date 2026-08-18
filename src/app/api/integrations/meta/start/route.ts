import { NextResponse } from "next/server";

import { isIntegrationConfigured } from "@/lib/env";
import { buildMetaAuthorizeUrl } from "@/server/integrations/meta-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isHubConnectError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// Meta'nın kendi consent ekranına yönlendiren başlangıç adımı — bkz.
// callback/route.ts geri dönüş için. google/start/route.ts ile aynı desen.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId gerekli" }, { status: 400 });
  }

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isHubConnectError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (!isIntegrationConfigured("META")) {
    return NextResponse.redirect(
      new URL(
        `/projects/${projectId}/entegrasyonlar?entegrasyon=meta&metaError=not_configured`,
        request.url,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId });
  return NextResponse.redirect(buildMetaAuthorizeUrl(state));
}
