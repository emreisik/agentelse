import "server-only";

import { parseLaunchSpec } from "@/lib/ads/launch-spec";
import {
  findTagEffects,
  findingRef,
  findingText,
  type LineageAdRow,
} from "@/lib/ads/lineage-stats";
import { prisma } from "@/lib/prisma";

import { progressOf } from "../launch/store";

// Fikirden reklama soy bağı sonuçları nitelik düzeyinde öğrenmeye çevirir
// (docs/meta-ads-autonomy.md): kanca tipi, teklif, biçim, uzunluk gibi
// etiketlere göre sonuç maliyeti karşılaştırılır; istatistik kapısını geçen
// fark BrandLearning olur. Bunlar Brand Twin'in "ne işe yarıyor / kaçın"
// belleğine girer, yani fikir motoruna ve kreatif brieflerine kendiliğinden
// geri akar. Kampanyalar arası değil, yalnız aynı tarif içinde karşılaştırır.

const WINDOW_DAYS = 28;
const LAUNCH_LOOKBACK_DAYS = 120;
const SOURCE_TYPE = "META_ADS_LINEAGE";
const DAY_MS = 24 * 60 * 60_000;

export const AdsLineageLearnings = {
  async writeDue(now: Date = new Date(), limitProjects = 25): Promise<number> {
    const launches = await prisma.adsLaunch.findMany({
      where: {
        status: { in: ["ACTIVE", "CREATED_PAUSED"] },
        createdAt: { gt: new Date(now.getTime() - LAUNCH_LOOKBACK_DAYS * DAY_MS) },
      },
      select: { projectId: true, spec: true, progress: true, adsAccountId: true },
      take: 800,
      orderBy: { createdAt: "desc" },
    });

    // Reklam kimliği -> (proje, tarif, etiketler)
    const byAd = new Map<
      string,
      { projectId: string; recipe: string; tags: Record<string, string> }
    >();
    for (const launch of launches) {
      const spec = parseLaunchSpec(launch.spec);
      if (!spec) continue;
      const adIds = progressOf(launch).ads ?? {};
      spec.ads.forEach((ad, index) => {
        const adId = adIds[String(index)];
        if (adId && ad.lineage) {
          byAd.set(adId, {
            projectId: launch.projectId,
            recipe: spec.recipe,
            tags: ad.lineage.tags,
          });
        }
      });
    }
    if (byAd.size === 0) return 0;

    const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const sums = await prisma.adsInsightDaily.groupBy({
      by: ["externalId"],
      where: {
        level: "AD",
        externalId: { in: [...byAd.keys()] },
        date: { gte: since },
      },
      _sum: { spendMinor: true, results: true },
    });

    const rowsByProject = new Map<string, LineageAdRow[]>();
    for (const sum of sums) {
      const ad = byAd.get(sum.externalId);
      if (!ad) continue;
      const rows = rowsByProject.get(ad.projectId) ?? [];
      rows.push({
        recipe: ad.recipe,
        adId: sum.externalId,
        tags: ad.tags,
        spendMinor: Number(sum._sum.spendMinor ?? 0),
        results: sum._sum.results ?? 0,
      });
      rowsByProject.set(ad.projectId, rows);
    }

    let written = 0;
    let projects = 0;
    for (const [projectId, rows] of rowsByProject) {
      if (projects >= limitProjects) break;
      const findings = findTagEffects(rows);
      if (findings.length === 0) continue;
      projects += 1;
      const brand = await prisma.brand.findFirst({
        where: { projectId, isDefault: true },
        select: { id: true, workspaceId: true },
      });
      if (!brand) continue;
      for (const finding of findings.slice(0, 8)) {
        const sourceRef = findingRef(finding);
        const insight = findingText(finding, "result");
        const confidence = Math.min(0.9, 0.5 + Math.abs(finding.z) / 20);
        const existing = await prisma.brandLearning.findFirst({
          where: { projectId, sourceType: SOURCE_TYPE, sourceRef },
          select: { id: true, polarity: true, evidenceCount: true },
        });
        if (existing) {
          await prisma.brandLearning.update({
            where: { id: existing.id },
            data: {
              insight,
              confidence,
              polarity: finding.polarity,
              evidenceCount:
                existing.polarity === finding.polarity
                  ? existing.evidenceCount + 1
                  : 1,
              lastReinforcedAt: now,
            },
          });
        } else {
          await prisma.brandLearning.create({
            data: {
              workspaceId: brand.workspaceId,
              projectId,
              brandId: brand.id,
              insight,
              sourceType: SOURCE_TYPE,
              sourceRef,
              confidence,
              polarity: finding.polarity,
              lastReinforcedAt: now,
            },
          });
        }
        written += 1;
      }
    }
    return written;
  },
};
