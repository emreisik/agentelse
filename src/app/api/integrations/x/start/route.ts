import { NextResponse } from "next/server";

import { isIntegrationConfigured } from "@/lib/env";
import { buildXAuthorizeUrl } from "@/server/integrations/x-client";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
} from "@/server/security/pkce";
import { signOAuthState } from "@/server/security/oauth-state";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// X'in kendi consent ekranına yönlendiren başlangıç adımı — bkz.
// callback/route.ts geri dönüş için. tiktok/start ile aynı desen: PKCE
// zorunlu, code_verifier imzalı state'e gömülüyor.
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

  if (!isIntegrationConfigured("X")) {
    return NextResponse.redirect(
      new URL(
        `/projects/${projectId}/integrations?integration=x&xError=not_configured`,
        request.url,
      ),
    );
  }

  const codeVerifier = generateCodeVerifier();
  const state = signOAuthState({ projectId, userId, codeVerifier });
  return NextResponse.redirect(
    buildXAuthorizeUrl(state, deriveCodeChallenge(codeVerifier)),
  );
}
