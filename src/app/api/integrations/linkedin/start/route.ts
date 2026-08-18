import { NextResponse } from "next/server";

import { isIntegrationConfigured } from "@/lib/env";
import { buildLinkedInAuthorizeUrl } from "@/server/integrations/linkedin-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// LinkedIn'in kendi consent ekranına yönlendiren başlangıç adımı — bkz.
// callback/route.ts geri dönüş için. google/start ile aynı desen (PKCE yok
// — LinkedIn'in 3-legged akışı bunu gerektirmiyor, tiktok/start'ın aksine).
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
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  if (!isIntegrationConfigured("LINKEDIN")) {
    return NextResponse.redirect(
      new URL(
        `/projects/${projectId}/integrations?integration=linkedin&linkedinError=not_configured`,
        request.url,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId });
  return NextResponse.redirect(buildLinkedInAuthorizeUrl(state));
}
