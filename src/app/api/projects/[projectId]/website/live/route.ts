import { NextResponse, type NextRequest } from "next/server";

import { GaFlags } from "@/lib/website-analytics/flags";
import {
  requireUser,
  requireProjectAccess,
} from "@/server/security/tenant-context";
import { isAgentelseError } from "@/server/security/errors";
import { GaLive } from "@/server/website-analytics/live";

// Website sayfasının canlı şeridi bunu yoklar (GA-F2 bölüm 2, GA_LIVE):
// ?part=today "Today so far", ?part=now "Right now". Sayılar yalnız bellekte
// tutulur; yanıt hiçbir yerde önbelleklenmez.

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  // Bayraklar kapalıyken uç yokmuş gibi davranır (oturum sınanmadan önce).
  if (!GaFlags.sync() || !GaFlags.websitePage() || !GaFlags.live()) {
    return NextResponse.json(
      { error: "Not found" },
      { status: 404, headers: NO_STORE },
    );
  }
  const { projectId } = await params;
  const part = request.nextUrl.searchParams.get("part");
  if (part !== "today" && part !== "now") {
    return NextResponse.json(
      { error: "Unknown part" },
      { status: 400, headers: NO_STORE },
    );
  }

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

  const result =
    part === "today"
      ? await GaLive.todaySoFar(projectId)
      : await GaLive.rightNow(projectId);
  return NextResponse.json(result, { headers: NO_STORE });
}
