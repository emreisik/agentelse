import { NextResponse } from "next/server";

import { isIntegrationConfigured } from "@/lib/env";
import { buildGoogleAuthorizeUrl } from "@/server/integrations/google-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The initial step that redirects to Google's own consent screen — see
// callback/route.ts for the return trip.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 },
    );
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

  if (!isIntegrationConfigured("GOOGLE")) {
    return NextResponse.redirect(
      new URL(
        `/projects/${projectId}/integrations?integration=google&googleError=not_configured`,
        request.url,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId });
  return NextResponse.redirect(buildGoogleAuthorizeUrl(state));
}
