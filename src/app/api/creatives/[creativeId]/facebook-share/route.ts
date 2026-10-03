import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { readFacebookShareState } from "@/server/commands/facebook-share";
import { isAgentelseError } from "@/server/security/errors";
import {
  requireProjectAccess,
  requireUser,
} from "@/server/security/tenant-context";

// The creative card's Facebook row reads its state here with a plain fetch,
// not a Server Action: Server Actions run one at a time per client, so a read
// per card (and the poll while a share runs) would hold up every other button
// on a Work page.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ creativeId: string }> },
) {
  const { creativeId } = await params;

  let userId: string;
  try {
    ({ userId } = await requireUser());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const creative = await prisma.creative.findUnique({
    where: { id: creativeId },
    select: { projectId: true },
  });
  if (!creative) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    await requireProjectAccess(userId, creative.projectId);
  } catch (error) {
    if (isAgentelseError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw error;
  }

  const state = await readFacebookShareState(creative.projectId, creativeId);
  return NextResponse.json(state, {
    headers: { "Cache-Control": "no-store" },
  });
}
