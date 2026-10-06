import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadWebsiteOverview } from "@/server/website-analytics/overview";

// Sağ paneldeki Website kartı bunu sayfa çizildikten sonra okur (GA-F2
// bölüm 2, GA_BRAND_CARD; yalnız ambar: Google'a çağrı yok).
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

  const overview = await loadWebsiteOverview(projectId);
  return NextResponse.json(overview, {
    headers: { "Cache-Control": "private, max-age=120" },
  });
}
