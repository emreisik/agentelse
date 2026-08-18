import "server-only";

import { insightFingerprint } from "@/server/agency/fingerprint";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { insightSynthesisDef } from "@/server/reasoning/prompts/insight-synthesis";
import { signalRelevanceDef } from "@/server/reasoning/prompts/signal-relevance";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { FindingRepository } from "@/server/repositories/finding.repository";
import { InsightRepository } from "@/server/repositories/insight.repository";
import { SignalRepository } from "@/server/repositories/signal.repository";

import { FindingWriter } from "./finding-writer";

// RAW SIGNAL -> NORMALIZE -> DEDUPLICATE -> RELEVANCE SCORE -> FINDING ->
// INSIGHT (spec section 17). Dedup already happened at ingest (fingerprint
// unique); this engine scores NEW signals and synthesizes insights from
// promoted ones.
export const IntelligenceEngine = {
  async processNewSignals(limit = 20): Promise<number> {
    const signals = await SignalRepository.listByStatus("NEW", limit);
    let processed = 0;

    for (const signal of signals) {
      const brand = await ConstitutionService.getBrandContext(signal.brandId);
      const { output } = await ReasoningService.run(signalRelevanceDef, {
        workspaceId: signal.workspaceId,
        projectId: signal.projectId,
        brandId: signal.brandId,
        context: {
          brand,
          signal: {
            title: signal.title,
            summary: signal.summary,
            category: signal.category,
            source: signal.source,
          },
        },
      });

      await SignalRepository.transition(signal.id, signal.projectId, "SCORED", {
        relevanceScore: output.relevanceScore,
      });

      if (output.shouldPromote) {
        await SignalRepository.transition(
          signal.id,
          signal.projectId,
          "PROMOTED",
        );
        // Promoted signal becomes a Finding so the intelligence corpus stays
        // unified for constitution/audits/insights.
        await FindingWriter.writeMany(
          {
            workspaceId: signal.workspaceId,
            projectId: signal.projectId,
            brandId: signal.brandId,
          },
          [
            {
              sourceType: "SIGNAL",
              signalId: signal.id,
              category: signal.category.toLowerCase(),
              statement: `${signal.title}${signal.summary ? ` — ${signal.summary}` : ""}`,
              classification: "LIKELY_FACT",
              confidence: (signal.reliability ?? 0.5) * (output.relevanceScore / 100),
              isMock: ReasoningService.isMockMode(),
            },
          ],
        );
      } else {
        await SignalRepository.transition(
          signal.id,
          signal.projectId,
          "DISCARDED",
        );
      }
      processed += 1;
    }

    return processed;
  },

  // Synthesizes insights for one project from its promoted-but-unconsumed
  // signals + recent findings. Insight dedup via fingerprint unique.
  async synthesizeInsights(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
  }): Promise<number> {
    const [signals, findings, brand] = await Promise.all([
      SignalRepository.listForProject(scope.projectId, {
        status: "PROMOTED",
        limit: 30,
      }),
      FindingRepository.listForProject(scope.projectId, { limit: 60 }),
      ConstitutionService.getBrandContext(scope.brandId),
    ]);

    if (signals.length === 0 && findings.length === 0) return 0;

    const items = [
      ...signals.map((s) => ({
        kind: "signal" as const,
        id: s.id,
        title: s.title,
        category: s.category,
      })),
      ...findings.slice(0, 40).map((f) => ({
        kind: "finding" as const,
        id: f.id,
        statement: f.statement,
        category: f.category ?? "general",
      })),
    ];

    const { output, isMock } = await ReasoningService.run(insightSynthesisDef, {
      ...scope,
      context: { brand, items },
    });

    let created = 0;
    for (const insight of output.insights) {
      const related = insight.relatedIndexes
        .map((i) => items[i])
        .filter((item): item is (typeof items)[number] => Boolean(item));
      const result = await InsightRepository.create({
        ...scope,
        title: insight.title,
        summary: insight.summary,
        category: related.find((r) => r.kind === "signal")
          ? signals.find((s) => s.id === related.find((r) => r.kind === "signal")?.id)?.category
          : undefined,
        findingIds: related
          .filter((r) => r.kind === "finding")
          .map((r) => r.id),
        signalIds: related.filter((r) => r.kind === "signal").map((r) => r.id),
        importance: insight.importance,
        fingerprint: insightFingerprint({ title: insight.title }),
        isMock,
      });
      if (!result.duplicate) created += 1;
    }

    return created;
  },

  // Projects that have promoted signals not yet folded into any insight.
  // Aday seçimi hem PROMOTED sinyallere hem de HENÜZ İŞLENMEMİŞ bulgulara
  // bakar. Yalnızca sinyale bakıldığında, araştırmadan gelen yüzlerce bulgu
  // olmasına rağmen (sinyal taraması henüz sinyal üretmediyse) proje hiç
  // seçilmiyor ve içgörü zinciri hiç başlamıyordu.
  async projectsNeedingInsights(limit = 5) {
    const { prisma } = await import("@/lib/prisma");

    const bySignal = await prisma.signal.groupBy({
      by: ["workspaceId", "projectId", "brandId"],
      where: { status: "PROMOTED" },
      _count: { id: true },
      orderBy: { projectId: "asc" },
      take: limit,
    });

    const candidates = new Map<
      string,
      { workspaceId: string; projectId: string; brandId: string; promotedCount: number }
    >();
    for (const group of bySignal) {
      candidates.set(group.projectId, {
        workspaceId: group.workspaceId,
        projectId: group.projectId,
        brandId: group.brandId,
        promotedCount: group._count.id,
      });
    }

    if (candidates.size < limit) {
      const byFinding = await prisma.finding.groupBy({
        by: ["workspaceId", "projectId", "brandId"],
        _max: { createdAt: true },
        orderBy: { projectId: "asc" },
        take: limit * 4,
      });

      for (const group of byFinding) {
        if (candidates.size >= limit) break;
        if (candidates.has(group.projectId)) continue;

        // Son bulgu son içgörüden yeniyse işlenmemiş malzeme var demektir.
        // Bu kontrol olmadan aynı proje her tick'te yeniden sentezlenip
        // kotayı boşa yakardı.
        const latestInsight = await prisma.insight.findFirst({
          where: { projectId: group.projectId },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        const latestFinding = group._max.createdAt;
        if (!latestFinding) continue;
        if (latestInsight && latestInsight.createdAt >= latestFinding) continue;

        candidates.set(group.projectId, {
          workspaceId: group.workspaceId,
          projectId: group.projectId,
          brandId: group.brandId,
          promotedCount: 0,
        });
      }
    }

    return [...candidates.values()];
  },
};
