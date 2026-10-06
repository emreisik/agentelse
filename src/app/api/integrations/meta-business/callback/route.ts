import { NextResponse } from "next/server";

import { AdsFlags } from "@/lib/ads/flags";
import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import { AdsConnections } from "@/server/ads/connections";
import { verifyOAuthState } from "@/server/security/oauth-state";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// Facebook Login for Business dönüşü (docs/meta-ads-plan.md F8): imzalı state
// oturumdaki kullanıcıyla eşleşmeli; kod BISU token'ına çevrilir, bağlantı
// workspace'e yazılır (yeniden bağlanınca atanmış projelerin kopyaları da
// yenilenir). Sonuç /ads sayfasında gösterilir.
function back(query: string) {
  return NextResponse.redirect(appUrl(`/ads?${query}`));
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!AdsFlags.agency()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (params.get("error")) return back("metaBusinessError=denied");
  const code = params.get("code");
  const state = verifyOAuthState(params.get("state") ?? "");
  if (!code || !state || state.userId !== userId || state.service !== "meta_business") {
    return back("metaBusinessError=invalid_state");
  }
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
    return back("metaBusinessError=not_admin");
  }
  try {
    await AdsConnections.connectFromCode({ workspaceId, userId, code });
  } catch (error) {
    console.error(
      "[meta-business] connect failed:",
      error instanceof Error ? error.message : error,
    );
    return back("metaBusinessError=connect_failed");
  }
  return back("metaBusinessConnected=1");
}
