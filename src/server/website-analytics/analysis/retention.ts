import "server-only";

import { prisma } from "@/lib/prisma";
import {
  GA_FINDING_HARD_RETENTION_DAYS,
  GA_FINDING_RETENTION_DAYS,
} from "@/lib/website-analytics/analysis/schedule";
import { gaGlobalWorkAllowedHere } from "@/lib/website-analytics/flags";
import { claimPeriodic } from "@/server/observability/periodic";

// GA-F4 saklama (docs/website-insights.md "Saklama"): kapanıştan 730 gün
// sonra satır silinir; kapanmamış kalmış her şey için oluşturulmadan 760
// gün sonra son bir süpürme. Günde bir, yalnız canlıda (paylaşılan kilit;
// geliştirme süreci hiç çalıştırmaz). Bayraktan bağımsızdır: GA_INSIGHTS ya
// da GA_SYNC sonradan kapatılsa da GaFinding satırı kaldığı sürece çalışır
// (24 ay sözü tutulur); bayrak kapalıyken varlık sorgusu süreç başına günde
// birdir.

const RETENTION_KEY = "ga.findings.retention";
const EVERY_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;

let idleCheckedAt: number | null = null;

export const GaFindingRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!gaGlobalWorkAllowedHere()) return 0;
    if (!(await claimPeriodic(RETENTION_KEY, EVERY_MS, now))) return 0;
    const deleted = await prisma.gaFinding.deleteMany({
      where: {
        OR: [
          {
            closedAt: {
              lt: new Date(now.getTime() - GA_FINDING_RETENTION_DAYS * DAY_MS),
            },
          },
          {
            createdAt: {
              lt: new Date(
                now.getTime() - GA_FINDING_HARD_RETENTION_DAYS * DAY_MS,
              ),
            },
          },
        ],
      },
    });
    return deleted.count;
  },

  // Bayrak kapalıyken (değerlendirici adımı erken döner) çağrılır.
  async runWhileOff(now: Date = new Date()): Promise<number> {
    if (!gaGlobalWorkAllowedHere()) return 0;
    if (idleCheckedAt !== null && now.getTime() - idleCheckedAt < EVERY_MS) {
      return 0;
    }
    idleCheckedAt = now.getTime();
    const row = await prisma.gaFinding.findFirst({ select: { id: true } });
    if (!row) return 0;
    return this.runDue(now);
  },

  // Testler için: süreç içi günlük kısmayı sıfırlar.
  resetIdleCheck(): void {
    idleCheckedAt = null;
  },
};
