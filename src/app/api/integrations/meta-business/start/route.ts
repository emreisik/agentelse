import { NextResponse } from "next/server";

import { AdsFlags } from "@/lib/ads/flags";
import { appUrl } from "@/lib/app-url";
import { prisma } from "@/lib/prisma";
import {
  buildBusinessLoginUrl,
  businessLoginConfigured,
} from "@/server/integrations/meta/business-login";
import { signOAuthState } from "@/server/security/oauth-state";
import {
  requireUser,
  requireWorkspaceMembership,
} from "@/server/security/tenant-context";

// Facebook Login for Business başlangıcı (docs/meta-ads-plan.md F8): müşterinin
// business portfolio'sunu workspace'e bağlar. Yalnız OWNER/ADMIN; state
// AUTH_SECRET ile imzalı ve 10 dakika geçerli (oauth-state.ts).
const META_BUSINESS_SERVICE = "meta_business";

export async function GET() {
  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!AdsFlags.agency()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { workspaceId } = await requireWorkspaceMembership(userId);
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (!member || (member.role !== "OWNER" && member.role !== "ADMIN")) {
    return NextResponse.redirect(appUrl("/ads?metaBusinessError=not_admin"));
  }
  if (!businessLoginConfigured()) {
    return NextResponse.redirect(appUrl("/ads?metaBusinessError=not_configured"));
  }
  const state = signOAuthState({
    projectId: "",
    userId,
    service: META_BUSINESS_SERVICE,
  });
  return NextResponse.redirect(buildBusinessLoginUrl(state));
}
