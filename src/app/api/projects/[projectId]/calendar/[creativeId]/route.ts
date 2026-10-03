import { NextResponse } from "next/server";

import { loadCalendarDetail } from "@/server/calendar/load-detail";
import { denyUnlessProjectMember } from "@/server/calendar/route-auth";

// Detay panelinin tembel yüklenen kısmı (tam metin, künye, bekleyen onay).
// Panel liste verisiyle anında açılır; bunu arkadan çeker.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string; creativeId: string }> },
) {
  const { projectId, creativeId } = await params;
  const denied = await denyUnlessProjectMember(projectId);
  if (denied) return denied;

  const detail = await loadCalendarDetail(projectId, creativeId);
  if (!detail) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(detail, {
    headers: { "Cache-Control": "no-store" },
  });
}
