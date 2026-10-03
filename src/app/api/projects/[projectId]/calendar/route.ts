import { NextResponse } from "next/server";

import { addDaysToKey, parseDayKey } from "@/lib/calendar/grid";
import { zonedDateTimeToUtc } from "@/lib/timezone";
import { loadCalendarData } from "@/server/calendar/load-calendar";
import { denyUnlessProjectMember } from "@/server/calendar/route-auth";
import { getProjectTimezone } from "@/server/chat/content-plan";

// En uzun görünür aralık 6 haftalık ay ızgarasıdır; payı bol tutulur.
const MAX_SPAN_DAYS = 62;

// Takvim panosunun hafif yoklama ucu: yalnız takvim verisi. Sayfayı komple
// yeniden render etmek (kenar çubuğu, journey snapshot...) yerine pano 30 snde
// bir burayı okur. Server Action değil: Server Action'lar istemci başına sıralı
// çalışır, bir yoklama sürükle-bırakın yazmasını bekletirdi.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  const denied = await denyUnlessProjectMember(projectId);
  if (denied) return denied;

  const search = new URL(request.url).searchParams;
  const from = search.get("from") ?? undefined;
  const to = search.get("to") ?? undefined;
  const last = to ? addDaysToKey(to, 0) : null;
  if (!parseDayKey(from) || !last || !from || from > last) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }
  if (addDaysToKey(from, MAX_SPAN_DAYS)! < last) {
    return NextResponse.json({ error: "Range too long" }, { status: 400 });
  }

  const timezone = await getProjectTimezone(projectId);
  const payload = await loadCalendarData({
    projectId,
    timezone,
    from: zonedDateTimeToUtc(`${from}T00:00`, timezone),
    // Son günün 23:59:59'una kadar.
    to: new Date(
      zonedDateTimeToUtc(`${last}T23:59`, timezone).getTime() + 59_999,
    ),
  });
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
