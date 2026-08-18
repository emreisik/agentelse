import "server-only";

import type { CouncilRecommendation } from "@prisma/client";

import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { councilEvaluationDef } from "@/server/reasoning/prompts/council-evaluation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { COUNCIL_RECOMMENDATION, COUNCIL_TYPE } from "@/lib/labels/ideas";

import { COUNCILS, pickCouncils } from "./councils";

// Structured multi-perspective idea evaluation (spec section 23). Walks the
// idea RAW -> VALIDATED -> CONCEPT -> SHORTLISTED (or REJECTED) based on the
// councils' combined recommendation.
export const CouncilEngine = {
  async evaluateIdea(
    ideaId: string,
    projectId: string,
  ): Promise<{
    recommendation: CouncilRecommendation | null;
  }> {
    const idea = await IdeaRepository.findByIdInProject(ideaId, projectId);
    if (!idea) return { recommendation: null };

    const scope = {
      workspaceId: idea.workspaceId,
      projectId: idea.projectId,
      brandId: idea.brandId,
    };

    const brand = await ConstitutionService.getBrandContext(idea.brandId);
    const councils = pickCouncils({
      lens: idea.lens,
      externallyVisible: true,
    });

    const recommendations: CouncilRecommendation[] = [];
    const evaluationNotes: {
      council: string;
      verdict: string;
      rationale?: string;
    }[] = [];
    for (const councilType of councils) {
      const definition = COUNCILS[councilType];
      const { output, isMock, reasoningCallId } = await ReasoningService.run(
        councilEvaluationDef,
        {
          ...scope,
          context: {
            councilType,
            dimensions: definition.dimensions,
            brand,
            idea: {
              title: idea.title,
              description: idea.description,
              lens: idea.lens,
              concept: idea.concept,
            },
          },
        },
      );

      await IdeaRepository.addCouncilEvaluation({
        ...scope,
        ideaId: idea.id,
        councilType,
        scores: output.scores,
        overallScore: output.overallScore,
        recommendation: output.recommendation,
        rationale: output.rationale,
        reasoningCallId,
        isMock,
      });
      recommendations.push(output.recommendation);
      evaluationNotes.push({
        council: COUNCIL_TYPE[councilType].label,
        verdict: COUNCIL_RECOMMENDATION[output.recommendation].label,
        rationale: output.rationale || undefined,
      });
    }

    // Combined verdict: any REJECT kills; any REVISE holds; otherwise the
    // idea advances to SHORTLISTED for the director.
    const combined: CouncilRecommendation = recommendations.includes("REJECT")
      ? "REJECT"
      : recommendations.includes("REVISE")
        ? "REVISE"
        : recommendations.includes("STRONG_APPROVE")
          ? "STRONG_APPROVE"
          : "APPROVE";

    await IdeaChatRepository.postSystemMessage({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      ideaId: idea.id,
      text: `🧭 Konsey değerlendirmesi tamamlandı — sonuç: **${COUNCIL_RECOMMENDATION[combined].label}**`,
      card: {
        kind: "council",
        verdict: combined,
        notes: evaluationNotes,
      },
    }).catch((error) => {
      console.error("[council-engine] postSystemMessage failed:", error);
    });

    if (combined === "REJECT") {
      await IdeaRepository.transition(idea.id, projectId, "REJECTED");
    } else if (combined === "REVISE") {
      // Stays at CONCEPT for a future revision cycle.
      if (idea.status === "RAW") {
        await IdeaRepository.transition(idea.id, projectId, "VALIDATED");
        await IdeaRepository.transition(idea.id, projectId, "CONCEPT");
      }
    } else {
      if (idea.status === "RAW") {
        await IdeaRepository.transition(idea.id, projectId, "VALIDATED");
        await IdeaRepository.transition(idea.id, projectId, "CONCEPT");
      }
      const current = await IdeaRepository.findByIdInProject(
        idea.id,
        projectId,
      );
      if (current?.status === "CONCEPT") {
        await IdeaRepository.transition(idea.id, projectId, "SHORTLISTED");
      }
    }

    return { recommendation: combined };
  },

  // RAW ideas without evaluations get a council pass.
  async evaluatePendingIdeas(limit = 5): Promise<number> {
    const ideas = await IdeaRepository.listByStatus("RAW", limit);
    let evaluated = 0;
    for (const idea of ideas) {
      if (idea.councilEvaluations.length > 0) continue;
      await this.evaluateIdea(idea.id, idea.projectId);
      evaluated += 1;
    }
    return evaluated;
  },
};
