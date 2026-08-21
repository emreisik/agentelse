import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { isIntegrationConfigured } from "@/lib/env";
import { buildLinkedInAuthorizeUrl } from "@/server/integrations/linkedin-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The start step that redirects to LinkedIn's own consent screen — see
// callback/route.ts for the return trip. Same pattern as google/start (no
// PKCE — LinkedIn's 3-legged flow doesn't require it, unlike tiktok/start).
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
      appUrl(
        `/projects/${projectId}/integrations?integration=linkedin&linkedinError=not_configured`,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId });
  return NextResponse.redirect(buildLinkedInAuthorizeUrl(state));
}
