import "server-only";

import { prisma } from "@/lib/prisma";

// Kayan 24 saatlik uygulama sayacı için ham veri: sitenin yazısı inmiş (noop
// olmayan) değişikliklerinin appliedAt değerleri. Pencere hesabı saf
// rateWindow'dadır (lifecycle.ts). Yazısı inmiş FAILED satırlar da sayılır:
// siteye gerçekten yazıldılar.
export async function appliedCountSince(
  siteId: string,
  since: Date,
): Promise<Date[]> {
  const rows = await prisma.seoChange.findMany({
    where: {
      siteId,
      noop: false,
      appliedAt: { gte: since },
      status: { in: ["APPLIED", "VERIFIED", "UNDOING", "UNDONE", "FAILED"] },
    },
    select: { appliedAt: true },
  });
  return rows
    .map((row) => row.appliedAt)
    .filter((at): at is Date => at !== null);
}
