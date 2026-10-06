import "server-only";

import { AdsFlags } from "@/lib/ads/flags";
import { metaWorkExcludedHere } from "@/lib/local-worker-policy";
import { prisma } from "@/lib/prisma";
import { claimPeriodic } from "@/server/observability/periodic";

// Saklama (docs/meta-ads-plan.md §4, K7): reklam düzeyi günlük veri 180 gün,
// diğer düzeyler 400 gün; Meta'da artık olmayan nesneler 90 gün; çözülen
// uyarılar 180 gün; webhook olayları 14 gün (F7). Otomatik eylem bildirimi
// 3 gün sonra kendiliğinden kapanır (Undo kartta 7 gün durur). Günde bir kez.

const DAY_MS = 24 * 60 * 60_000;

export const AdsRetention = {
  async runDue(now: Date = new Date()): Promise<number> {
    if (!AdsFlags.sync()) return 0;
    if (metaWorkExcludedHere(process.env)) return 0;
    if (!(await claimPeriodic("ads.retention", DAY_MS, now))) return 0;
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const [ads, others, objects, alerts, webhookEvents, autoNotices] = await Promise.all([
      prisma.adsInsightDaily.deleteMany({
        where: { level: "AD", date: { lt: before(180) } },
      }),
      prisma.adsInsightDaily.deleteMany({
        where: { level: { not: "AD" }, date: { lt: before(400) } },
      }),
      prisma.adsObject.deleteMany({ where: { goneAt: { lt: before(90) } } }),
      prisma.adsAlert.deleteMany({
        where: { status: "RESOLVED", resolvedAt: { lt: before(180) } },
      }),
      prisma.adsWebhookEvent.deleteMany({
        where: { receivedAt: { lt: before(14) } },
      }),
      prisma.adsAlert.updateMany({
        where: {
          kind: "AUTO_ACTION",
          status: { in: ["OPEN", "ACKED"] },
          firstSeenAt: { lt: before(3) },
        },
        data: { status: "RESOLVED", resolvedAt: now },
      }),
    ]);
    return (
      ads.count +
      others.count +
      objects.count +
      alerts.count +
      webhookEvents.count +
      autoNotices.count
    );
  },
};
