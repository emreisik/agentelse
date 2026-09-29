import { NextResponse } from "next/server";

import { appUrl } from "@/lib/app-url";
import { isIntegrationConfigured } from "@/lib/env";
import {
  META_PROVIDER,
  buildMetaAuthorizeUrl,
  parseMetaService,
} from "@/server/integrations/meta-client";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The initial step that redirects to Meta's own consent screen — see
// callback/route.ts for the return trip. Same pattern as
// google/start/route.ts: `service` picks which of the two separate Meta
// integrations (instagram / ads) is being connected; only that service's
// scopes are requested.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const service = parseMetaService(searchParams.get("service"));
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

  if (!isIntegrationConfigured("META")) {
    return NextResponse.redirect(
      appUrl(
        `/projects/${projectId}/integrations?integration=${META_PROVIDER[service]}&metaError=not_configured`,
      ),
    );
  }

  const state = signOAuthState({ projectId, userId, service });
  return NextResponse.redirect(buildMetaAuthorizeUrl(state, service));
}
