import "server-only";

import { prisma } from "@/lib/prisma";
import { gscAgencyOn } from "@/lib/seo/agency/flags";
import type { SplitCounters } from "@/lib/seo/agency/types";
import { gscMockMode } from "@/server/integrations/search-console/search-analytics";

// Operatör sayaçları (yalnız sayılar, ad ve adres yok). Bayrak kapalıyken
// veritabanına gidilmez.

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 30;

export async function loadSplitCounters(
  now: Date = new Date(),
): Promise<SplitCounters | null> {
  if (!gscAgencyOn()) return null;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  // Tek sorgu: açık testler ile son 30 günde sonuçlananlar durum başına.
  const groups = await prisma.gscSplitTest.groupBy({
    by: ["status"],
    where: {
      isMock: gscMockMode(),
      OR: [
        { status: { in: ["DRAFT", "APPLIED", "EVALUATING"] } },
        { updatedAt: { gte: since } },
      ],
    },
    _count: { _all: true },
  });
  const of = (status: string): number =>
    groups.find((group) => group.status === status)?._count._all ?? 0;
  const applied = of("APPLIED");
  const evaluating = of("EVALUATING");
  return {
    open: of("DRAFT") + applied + evaluating,
    applied,
    evaluating,
    evaluated30d: {
      worked: of("WORKED"),
      didnt: of("DIDNT"),
      inconclusive: of("INCONCLUSIVE"),
    },
    expired30d: of("EXPIRED"),
  };
}
