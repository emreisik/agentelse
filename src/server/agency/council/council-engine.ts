import "server-only";

import type { CouncilRecommendation } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { councilEvaluationDef } from "@/server/reasoning/prompts/council-evaluation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
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
    // False only for INITIAL_IDEA_PORTFOLIO (agency-wiring.ts), this
    // function's sole caller today — the one-time onboarding batch
    // shouldn't post "council review" cards into a brand-new project's
    // chat. Evaluation itself (scores, recommendation, the idea's status
    // transition below) is unaffected; only the chat message is skipped.
    opts?: { postToChat?: boolean },
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

    // Real competitor evidence (see competitor-materializer.ts), not the
    // LLM's general knowledge — without this the "evidence" dimension had
    // nothing project-specific to ground itself in. Most recent first, capped
    // small: this is prompt context, not a report.
    const competitorInsights = await prisma.competitorInsight.findMany({
      where: { competitor: { projectId } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        insight: true,
        confidence: true,
        competitor: { select: { name: true } },
      },
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
            competitorInsights: competitorInsights.map((i) => ({
              competitor: i.competitor.name,
              insight: i.insight,
              confidence: i.confidence,
            })),
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

    if (opts?.postToChat !== false) {
      await IdeaChatRepository.postSystemMessage({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ideaId: idea.id,
        text: `🧭 Council evaluation completed — result: **${COUNCIL_RECOMMENDATION[combined].label}**`,
        card: {
          kind: "council",
          verdict: combined,
          notes: evaluationNotes,
        },
      }).catch((error) => {
        console.error("[council-engine] postSystemMessage failed:", error);
      });
    }

    if (combined === "REJECT") {
      await IdeaRepository.transition(idea.id, projectId, "REJECTED");
    } else {
      // APPROVE / STRONG_APPROVE / REVISE all advance to SHORTLISTED.
      // REVISE previously stopped here "for a future revision cycle" that
      // never existed anywhere in the pipeline (evaluatePendingIdeas only
      // ever re-scans status:"RAW") — REVISE ideas sat at CONCEPT forever,
      // which silently blocked draft/creative generation for anything a
      // council flagged (routine for a regulated vertical like fintech,
      // where RISK legitimately asks for legal review on most ideas). This
      // is safe to advance: REVISE's rationale (often compliance concerns)
      // stays on each CouncilEvaluation.rationale row for whoever reviews
      // the draft, and publishing is a fully separate, human-triggered,
      // LEVEL_3_CLIENT-gated flow (execution-policy.ts) independent of idea
      // status — advancing here only unblocks draft creation, never a
      // public publish.
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

  // RAW ideas without evaluations get a council pass. Per-idea error
  // boundary: listByStatus spreads its `limit` slots across distinct
  // projects, so one idea that fails to evaluate must not also block every
  // OTHER project's idea in the same batch.
  async evaluatePendingIdeas(limit = 5): Promise<number> {
    const ideas = await IdeaRepository.listByStatus("RAW", limit);
    let evaluated = 0;
    for (const idea of ideas) {
      if (idea.councilEvaluations.length > 0) continue;
      // Paused project — skip without processing, exactly like
      // signal-universe.ts's own scan skip. Try again next tick.
      if (!(await isProjectAgencyActive(idea.projectId))) continue;
      try {
        await this.evaluateIdea(idea.id, idea.projectId);
        evaluated += 1;
      } catch (error) {
        console.error(
          `[council-engine] evaluateIdea failed for idea ${idea.id} (${idea.title}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return evaluated;
  },
};
