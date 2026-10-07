import "server-only";

import { prisma } from "@/lib/prisma";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";

// RISC olay kayıtları (yalnız jti + olay anahtarları + sonuç) 30 gün tutulur:
// tekrar koruması bu pencere kadar sürer. Canlı veritabanını paylaşan yerel
// süreç hiç sorgu atmaz.

const RETENTION_DAYS = 30;

export const GoogleRisc = {
  async retention(now: Date = new Date()): Promise<number> {
    if (!gaGlobalWorkAllowedHere()) return 0;
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);
    const result = await prisma.googleRiscEvent.deleteMany({
      where: { receivedAt: { lt: cutoff } },
    });
    return result.count;
  },
};
