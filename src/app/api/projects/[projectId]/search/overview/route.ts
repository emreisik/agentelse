import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadSearchOverview } from "@/server/seo/overview";

// Sağ paneldeki Search kartı bunu sayfa çizildikten sonra okur (yalnız ambar:
// Google'a çağrı yok).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

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

  const overview = await loadSearchOverview(projectId);
  return NextResponse.json(overview, {
    headers: { "Cache-Control": "private, max-age=120" },
  });
}
