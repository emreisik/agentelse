import { NextResponse } from "next/server";

import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { getAgencyStatusSnapshot } from "@/server/agency/agency-status-snapshot";

// Lightweight polling target for the sidebar's ActiveWorkPopover — same split as
// setup-status's route: SSR the first paint (AppShell), poll this JSON
// endpoint afterward instead of a full-page LiveRefresh.
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

  const snapshot = await getAgencyStatusSnapshot(projectId);
  return NextResponse.json({ snapshot });
}
