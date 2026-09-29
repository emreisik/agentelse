import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { isIntegrationConfigured } from "@/lib/env";
import {
  GOOGLE_PROVIDER,
  buildGoogleAuthorizeUrl,
  parseGoogleService,
} from "@/server/integrations/google-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The initial step that redirects to Google's own consent screen — see
// callback/route.ts for the return trip. `service` picks which of the two
// separate Google integrations (analytics / search_console) is being
// connected; only that service's scope is requested.
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
      appUrl(
        `/projects/${projectId}/integrations?integration=${GOOGLE_PROVIDER[service]}&googleError=not_configured`,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId, service });
  return NextResponse.redirect(buildGoogleAuthorizeUrl(state, service));
}
