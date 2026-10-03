import "server-only";

import { prisma } from "@/lib/prisma";
import type { CalendarDetail } from "@/lib/calendar/types";
import { dayKeyInTimezone } from "@/lib/timezone";

// Detay panelinin ağır kısmı: tam metin, künye ve bekleyen onay. Kart panelde
// anında açılır (liste verisiyle); bunlar tembel gelir. İki küçük sorgu, birlikte.
export async function loadCalendarDetail(
  projectId: string,
  creativeId: string,
): Promise<CalendarDetail | null> {
  const [creative, approval] = await Promise.all([
    prisma.creative.findFirst({
      where: { id: creativeId, projectId },
      select: {
        platform: true,
        goal: true,
        createdAt: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: {
            version: true,
            caption: true,
            copy: true,
            contentFormat: true,
            asset: { select: { filename: true } },
          },
        },
      },
    }),
    prisma.approval.findFirst({
      where: {
        entityType: "Creative",
        entityId: creativeId,
        status: "PENDING",
      },
      select: { id: true },
    }),
  ]);
  if (!creative) return null;

  const version = creative.versions[0];
  return {
    caption: version?.caption?.trim() || null,
    copy: version?.copy?.trim() || null,
    goal: creative.goal,
    createdAt: creative.createdAt.toISOString(),
    version: version?.version ?? null,
    platform: creative.platform,
    contentFormat: version?.contentFormat ?? null,
    filename: version?.asset?.filename ?? null,
    approvalId: approval?.id ?? null,
  };
}

// Bir parçanın proje saat dilimindeki günü ("YYYY-MM-DD"), günü yoksa null.
// `?creative=` ile gelen bir bağlantı o parçanın ayını/haftasını açabilsin diye
// (yoksa takvim bugünün ayını açar ve parça görünür aralıkta olmaz).
export async function loadCreativeLocalDay(
  projectId: string,
  creativeId: string,
  timezone: string,
): Promise<string | null> {
  const creative = await prisma.creative.findFirst({
    where: { id: creativeId, projectId },
    select: { scheduledFor: true },
  });
  return creative?.scheduledFor
    ? dayKeyInTimezone(creative.scheduledFor, timezone)
    : null;
}
