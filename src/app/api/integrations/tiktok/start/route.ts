import { NextResponse } from "next/server";

import { isIntegrationConfigured } from "@/lib/env";
import { buildTikTokAuthorizeUrl } from "@/server/integrations/tiktok-client";
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

// TikTok'un kendi consent ekranına yönlendiren başlangıç adımı — bkz.
// callback/route.ts geri dönüş için. google/start ve meta/start ile aynı
// desen, tek fark: TikTok PKCE zorunlu kıldığı için code_verifier üretilip
// imzalı state'e gömülüyor (bkz. oauth-state.ts, pkce.ts).
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

  if (!isIntegrationConfigured("TIKTOK")) {
    return NextResponse.redirect(
      new URL(
        `/projects/${projectId}/integrations?integration=tiktok&tiktokError=not_configured`,
        request.url,
      ),
    );
  }

  const codeVerifier = generateCodeVerifier();
  const state = signOAuthState({ projectId, userId, codeVerifier });
  return NextResponse.redirect(
    buildTikTokAuthorizeUrl(state, deriveCodeChallenge(codeVerifier)),
  );
}
