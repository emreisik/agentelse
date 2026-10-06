import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadAdsOverview } from "@/server/ads/overview";

// The right panel's Ads card reads this after the page has rendered (the
// mirror only: no Meta call).
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

  const overview = await loadAdsOverview(projectId);
  return NextResponse.json(overview, {
    headers: { "Cache-Control": "private, max-age=120" },
  });
}
