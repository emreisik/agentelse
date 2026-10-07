import "server-only";

import { prisma } from "@/lib/prisma";
import { learningText } from "@/lib/website-analytics/analysis/describe";
import { isGaRuleKey } from "@/lib/website-analytics/analysis/registry";
import { gaAgencyEnabled } from "@/lib/website-analytics/agency/flags";
import {
  parseGaFindingEvidence,
  parseGaOutcomeEvidence,
} from "@/lib/website-analytics/analysis/stored";

// GA-F4 öğrenmeleri (docs/website-insights.md "Öğrenmeler"): yalnız WORKED
// sonucu, canlı ve mock olmayan bulgudan, iki pencerede toplam ≥ 10 isabetle
// tek BrandLearning (polarity WORKS) yazılır. DIDNT/INCONCLUSIVE öğrenme
// yazmaz: "bir sayfadaki değişikliklerden kaçın" yanıltıcı içerik rehberi
// olurdu. Metin yol, terim ve sayı taşımaz (sonraki marka bağlamlarına
// eklenir). Aynı bulgu iki kez yazılmaz (sourceType + sourceRef).

export const GA_LEARNING_SOURCE_TYPE = "GA4";

const MIN_HITS = 10;
const SIGNIFICANT_P = 0.05;

export async function writeFindingLearning(
  findingId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const finding = await prisma.gaFinding.findUnique({
    where: { id: findingId },
  });
  if (
    !finding ||
    finding.status !== "EVALUATED" ||
    finding.mode !== "live" ||
    finding.isMock ||
    finding.outcome !== "WORKED" ||
    !isGaRuleKey(finding.ruleKey)
  ) {
    return false;
  }
  const evidence = parseGaFindingEvidence(finding.evidence);
  const outcome = parseGaOutcomeEvidence(finding.outcomeEvidence);
  if (!evidence || !outcome) return false;
  if (outcome.before.hits + outcome.after.hits < MIN_HITS) return false;

  // GA-F8: öğrenme proje düzeyinde marka belleğine gider; yalnız ana mülkün
  // bulgusu yazar (ek mülkün bulgusu başka bir sitenin dersi olabilir).
  // Bayrak kapalıyken ek sorgu yok, davranış eskisiyle aynı.
  if (gaAgencyEnabled()) {
    const link = await prisma.gaPropertyLink.findUnique({
      where: { id: finding.linkId },
      select: { isPrimary: true },
    });
    if (!link?.isPrimary) return false;
  }

  const exists = await prisma.brandLearning.findFirst({
    where: { sourceType: GA_LEARNING_SOURCE_TYPE, sourceRef: finding.id },
    select: { id: true },
  });
  if (exists) return false;
  const brand = await prisma.brand.findFirst({
    where: { projectId: finding.projectId, isDefault: true },
    select: { id: true },
  });
  if (!brand) return false;

  await prisma.brandLearning.create({
    data: {
      workspaceId: finding.workspaceId,
      projectId: finding.projectId,
      brandId: brand.id,
      insight: learningText({ ruleKey: finding.ruleKey, evidence }),
      sourceType: GA_LEARNING_SOURCE_TYPE,
      sourceRef: finding.id,
      confidence: outcome.p !== null && outcome.p < SIGNIFICANT_P ? 0.8 : 0.5,
      polarity: "WORKS",
      lastReinforcedAt: now,
    },
  });
  return true;
}
