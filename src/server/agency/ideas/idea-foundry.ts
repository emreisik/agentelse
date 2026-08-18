import "server-only";

import type { CreativeLens, Opportunity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { ideaGenerationDef } from "@/server/reasoning/prompts/idea-generation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

import { DEFAULT_LENS_MIX, LENS_DEFINITIONS } from "./creative-lenses";

// Fikrin sohbetteki "sıfır noktası"nın ÖNCESİni de göster: bu fikri doğuran
// Sinyal(ler)/Bulgu(lar)/İçgörü+Fırsat zincirini (Opportunity.insightId ->
// Insight.{signalIds,findingIds}) KENDİ gerçek oluşturulma anlarıyla, fikir
// mesajından ÖNCE gelecek kronolojik sırada yazar. Zincir yoksa (elle
// oluşturulan/opportunity'siz fikir) sessizce atlanır. Best-effort — bir
// köken mesajının yazılamaması fikir oluşturma akışını asla durdurmamalı.
async function postOriginLineage(
  scope: { workspaceId: string; projectId: string },
  opportunity: Opportunity,
  ideaId: string,
) {
  if (!opportunity.insightId) return;
  const insight = await prisma.insight.findUnique({
    where: { id: opportunity.insightId },
  });
  if (!insight) return;

  const [signals, findings] = await Promise.all([
    prisma.signal.findMany({
      where: { id: { in: insight.signalIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.finding.findMany({
      where: { id: { in: insight.findingIds } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  for (const signal of signals) {
    await IdeaChatRepository.postSystemMessage({
      ...scope,
      ideaId,
      text: `📡 Sinyal tespit edildi: **${signal.title}**${signal.summary ? `\n\n${signal.summary}` : ""}`,
      card: {
        kind: "signal",
        title: signal.title,
        summary: signal.summary ?? undefined,
      },
      createdAt: signal.createdAt,
    });
  }

  for (const finding of findings) {
    await IdeaChatRepository.postSystemMessage({
      ...scope,
      ideaId,
      text: `🔍 Bulgu: ${finding.statement}`,
      card: {
        kind: "finding",
        title: finding.category ?? "Bulgu",
        statement: finding.statement,
      },
      createdAt: finding.createdAt,
    });
  }

  await IdeaChatRepository.postSystemMessage({
    ...scope,
    ideaId,
    text: `✨ İçgörü/Fırsat: **${opportunity.title}**${opportunity.description ? `\n\n${opportunity.description}` : ""}`,
    card: {
      kind: "insight-opportunity",
      title: opportunity.title,
      summary: insight.summary,
      description: opportunity.description ?? undefined,
    },
    createdAt: opportunity.createdAt,
  });
}

// Opportunity -> multiple diverse Ideas (spec sections 19-21). One reasoning
// call generates one idea per lens; per-(opportunity, lens) soft dedup stops
// repeat generation.
export const IdeaFoundry = {
  async generateForOpportunity(
    opportunityId: string,
    projectId: string,
    opts?: { lenses?: CreativeLens[] },
  ): Promise<number> {
    const opportunity = await OpportunityRepository.findByIdInProject(
      opportunityId,
      projectId,
    );
    if (!opportunity) return 0;

    const scope = {
      workspaceId: opportunity.workspaceId,
      projectId: opportunity.projectId,
      brandId: opportunity.brandId,
    };

    const policy = await AutonomyPolicyRepository.getOrCreate(scope);
    const activeIdeas = await IdeaRepository.countActive(projectId);
    if (!policy.unlimitedMode && activeIdeas >= policy.maxActiveIdeas) return 0;

    const requestedLenses = opts?.lenses ?? DEFAULT_LENS_MIX;
    const lenses: CreativeLens[] = [];
    for (const lens of requestedLenses) {
      const exists = await IdeaRepository.existsForOpportunityLens(
        opportunityId,
        lens,
      );
      if (!exists) lenses.push(lens);
    }
    if (lenses.length === 0) return 0;

    const brand = await ConstitutionService.getBrandContext(
      opportunity.brandId,
    );

    const { output, isMock } = await ReasoningService.run(ideaGenerationDef, {
      ...scope,
      context: {
        brand,
        opportunity: {
          title: opportunity.title,
          description: opportunity.description,
          category: opportunity.category,
        },
        lenses,
      },
    });

    let created = 0;
    for (const idea of output.ideas) {
      const lens = lenses.find((l) => l === idea.lens) ?? lenses[0];
      if (!lens || !(lens in LENS_DEFINITIONS)) continue;
      const createdIdea = await IdeaRepository.create({
        ...scope,
        opportunityId,
        lens,
        title: idea.title,
        description: idea.description,
        concept: idea.concept,
        isMock,
      });
      created += 1;

      // Fikrin sohbetteki "sıfır noktası"nın ÖNCESİni yaz (Sinyal/Bulgu/
      // İçgörü+Fırsat, kendi gerçek tarihleriyle) — idea mesajından ÖNCE,
      // ki sohbet kronolojik sırayla açılsın. Best-effort.
      await postOriginLineage(scope, opportunity, createdIdea.id).catch(
        (error) => {
          console.error("[idea-foundry] postOriginLineage failed:", error);
        },
      );

      // Bu fikrin sohbet iş parçacığının sıfır noktası: pipeline'ın ondan
      // sonraki her adımı (konsey, iş planı, görev/kreatif) aynı ideaId
      // altında bu mesajın devamı olarak birikir. Yazma başarısız olsa
      // bile fikir oluşturma akışı durmamalı.
      await IdeaChatRepository.postSystemMessage({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ideaId: createdIdea.id,
        text: `💡 Yeni fikir üretildi: **${idea.title}**\n\n${idea.description}`,
        card: {
          kind: "idea",
          title: idea.title,
          description: idea.description,
        },
      }).catch((error) => {
        console.error("[idea-foundry] postSystemMessage failed:", error);
      });
    }

    if (created > 0) {
      await AutonomyPolicyRepository.checkAndIncrement(
        scope,
        "ideasCreated",
        created,
      ).catch(() => undefined);
      if (opportunity.status === "EVALUATED") {
        await OpportunityRepository.transition(
          opportunityId,
          projectId,
          "ACCEPTED",
        );
      }
    }

    return created;
  },

  // NBA-ranked EVALUATED opportunities without ideas get a generation pass.
  async generateForTopOpportunities(limit = 3): Promise<number> {
    const { prisma } = await import("@/lib/prisma");
    const candidates = await prisma.opportunity.findMany({
      where: { status: "EVALUATED", ideas: { none: {} } },
      orderBy: [{ nbaScore: "desc" }, { createdAt: "asc" }],
      take: limit,
    });
    let total = 0;
    for (const opportunity of candidates) {
      total += await this.generateForOpportunity(
        opportunity.id,
        opportunity.projectId,
      );
    }
    return total;
  },
};
