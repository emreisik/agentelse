import { NextResponse } from "next/server";

import { denyUnlessProjectMember } from "@/server/calendar/route-auth";
import { getProjectTimezone } from "@/server/chat/content-plan";
import { loadOutputs } from "@/server/outputs/load-outputs";

// Sağ panel Outputs sekmesinin hafif okuma ucu: sekme açılınca ve 30 sn'de bir
// okunur. Sayfayı yeniden render etmez (Server Action değil: onlar istemci
// başına sıralı çalışır, bir okuma onay/ret yazmasını bekletirdi).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const denied = await denyUnlessProjectMember(projectId);
  if (denied) return denied;

  const timezone = await getProjectTimezone(projectId);
  const payload = await loadOutputs({ projectId, timezone });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
