import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";

// Lightweight polling target for SetupProgressWidget — a full page
// LiveRefresh (router.refresh()) is too heavy for a widget that stays
// mounted while the user browses unrelated panels.
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

  const setupState = await prisma.projectSetupState.findUnique({
    where: { projectId },
    include: { stageRecords: { select: { status: true } } },
  });

  if (!setupState || setupState.activatedAt) {
    return NextResponse.json({ percent: null, activated: true });
  }

  const total = setupState.stageRecords.length || 12;
  const done = setupState.stageRecords.filter(
    (r) => r.status === "COMPLETED" || r.status === "SKIPPED",
  ).length;
  const percent = Math.round((done / total) * 100);

  return NextResponse.json({ percent, activated: false });
}
