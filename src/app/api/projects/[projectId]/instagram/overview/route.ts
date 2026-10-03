import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { loadInstagramOverview } from "@/server/integrations/instagram-overview";

// The right panel's Instagram card reads this after the page has rendered, so
// a slow Meta answer never holds up the workspace.
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

  const overview = await loadInstagramOverview(projectId);
  return NextResponse.json(overview, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
