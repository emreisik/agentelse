import "server-only";

import { prisma } from "@/lib/prisma";

// Brand Brain öğrenmeleri (docs/meta-ads-plan.md §3.7): değerlendirilmiş bir
// karar istatistik kapısını geçtiyse (WORKED / DIDNT) BrandLearning yazılır;
// metin n'yi içerir, küçük örneklem "directional" etiketi taşır. Kişisel veri
// yazılmaz. Öğrenmeler fikir motorunu ve kreatif brieflerini besler.

const DIRECTIONAL_BELOW = 25;
const MIN_RESULTS = 10;

type OutcomeData = {
  before?: { results?: number | null };
  after?: { results?: number | null };
  ratio?: number | null;
};

export function learningText(input: {
  ruleKey: string;
  kind: string;
  outcome: "WORKED" | "DIDNT";
  ratio: number;
  n: number;
}): string {
  const pct = Math.round(Math.abs(input.ratio - 1) * 100);
  const tag =
    input.n < DIRECTIONAL_BELOW ? `n=${input.n}, directional` : `n=${input.n}`;
  const better = input.ratio < 1;
  switch (input.kind) {
    case "BUDGET_DOWN":
      return input.outcome === "WORKED"
        ? `Lowering the budget of an expensive ad set cut the cost per result by ${pct}% (${tag}).`
        : `Lowering the budget didn't bring the cost per result down (${tag}).`;
    case "BUDGET_UP":
      return input.outcome === "WORKED"
        ? `A 20% budget increase brought more results at a similar cost (${tag}).`
        : `A 20% budget increase pushed the cost per result up ${pct}% (${tag}).`;
    case "PAUSE":
      return input.outcome === "WORKED"
        ? `Pausing ads that spent without results lowered the cost per result by ${pct}% (${tag}).`
        : `Pausing that ad didn't lower the cost per result (${tag}).`;
    default:
      return `${input.ruleKey}: the cost per result went ${better ? "down" : "up"} ${pct}% after the change (${tag}).`;
  }
}

export const AdsLearnings = {
  async writeDue(now: Date = new Date(), limit = 20): Promise<number> {
    const decisions = await prisma.adsDecision.findMany({
      where: {
        outcome: { in: ["WORKED", "DIDNT"] },
        evaluatedAt: { gt: new Date(now.getTime() - 30 * 24 * 60 * 60_000) },
        kind: { in: ["BUDGET_DOWN", "BUDGET_UP", "PAUSE"] },
      },
      take: limit * 3,
      orderBy: { evaluatedAt: "desc" },
    });
    let written = 0;
    for (const decision of decisions) {
      if (written >= limit) break;
      const exists = await prisma.brandLearning.findFirst({
        where: { sourceType: "META_ADS", sourceRef: decision.id },
        select: { id: true },
      });
      if (exists) continue;
      const data = (decision.outcomeData ?? {}) as OutcomeData;
      const n = Math.min(data.before?.results ?? 0, data.after?.results ?? 0);
      if (n < MIN_RESULTS || typeof data.ratio !== "number") continue;
      const brand = await prisma.brand.findFirst({
        where: { projectId: decision.projectId, isDefault: true },
        select: { id: true },
      });
      if (!brand) continue;
      await prisma.brandLearning.create({
        data: {
          workspaceId: decision.workspaceId,
          projectId: decision.projectId,
          brandId: brand.id,
          insight: learningText({
            ruleKey: decision.ruleKey,
            kind: decision.kind,
            outcome: decision.outcome as "WORKED" | "DIDNT",
            ratio: data.ratio,
            n,
          }),
          sourceType: "META_ADS",
          sourceRef: decision.id,
          confidence: n >= DIRECTIONAL_BELOW ? 0.8 : 0.5,
          polarity: decision.outcome === "WORKED" ? "WORKS" : "AVOID",
          lastReinforcedAt: now,
        },
      });
      written += 1;
    }
    return written;
  },
};
