import { NextResponse } from "next/server";

import { SeoActionFlags } from "@/lib/seo/action-flags";
import { loadSeoCardStatus } from "@/server/modules/seo/card-status";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// SEO Manager kartının Deliver adımı bunu okur (docs/search-actions.md "SEO
// Manager"): takvimdeki parçanın durumu, eylemin durumu/sonucu ve Fix this'ten
// gelen konu önerisi. Yanıt hiçbir yerde önbelleklenmez.

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; commandId: string }> },
) {
  // Bayrak kapalıyken uç yokmuş gibi davranır (oturum sınanmadan önce).
  if (!SeoActionFlags.manager()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const { projectId, commandId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE },
    );
  }

  try {
    await requireProjectAccess(userId, projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: NO_STORE },
      );
    }
    throw error;
  }

  const status = await loadSeoCardStatus(projectId, commandId);
  if (!status) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  return NextResponse.json(status, { headers: NO_STORE });
}
