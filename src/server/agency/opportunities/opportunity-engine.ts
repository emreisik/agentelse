import "server-only";

import { opportunityFingerprint } from "@/server/agency/fingerprint";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { opportunityEvaluationDef } from "@/server/reasoning/prompts/opportunity-evaluation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { InsightRepository } from "@/server/repositories/insight.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";

// Insight -> Opportunity evaluation (spec section 18). An insight never
// becomes a task directly; it becomes an Opportunity with explicit value/
// urgency/evidence/risk scores linked to ProjectGoals — or nothing at all.
export const OpportunityEngine = {
  async evaluateInsight(
    insightId: string,
    projectId: string,
  ): Promise<{ created: boolean; opportunityId?: string }> {
    const insight = await InsightRepository.findByIdInProject(
      insightId,
      projectId,
    );
    if (!insight || insight.status === "ARCHIVED") return { created: false };

    const scope = {
      workspaceId: insight.workspaceId,
      projectId: insight.projectId,
      brandId: insight.brandId,
    };

    // Open-opportunity cap (noise control, spec section 37).
    const policy = await AutonomyPolicyRepository.getOrCreate(scope);
    const open = await OpportunityRepository.countOpen(projectId);
    if (!policy.unlimitedMode && open >= policy.maxOpenOpportunities) {
      return { created: false };
    }

    const [brand, goals] = await Promise.all([
      ConstitutionService.getBrandContext(insight.brandId),
      ProjectGoalRepository.listActiveOrApproved(projectId),
    ]);

    const { output, isMock } = await ReasoningService.run(
      opportunityEvaluationDef,
      {
        ...scope,
        context: {
          brand,
          goals: goals.map((g) => ({ title: g.title, metricKey: g.metricKey })),
          insight: {
            title: insight.title,
            summary: insight.summary,
            importance:
              insight.importance === null ? undefined : insight.importance,
          },
        },
      },
    );

    if (insight.status === "NEW") {
      await InsightRepository.transition(insight.id, projectId, "EVALUATED");
    }

    if (!output.matters) {
      await InsightRepository.transition(insight.id, projectId, "ARCHIVED");
      return { created: false };
    }

    const fingerprint = opportunityFingerprint({
      category: insight.category,
      title: output.title,
    });

    // Cooldown gate: a recently dismissed/expired same-fingerprint
    // opportunity blocks recreation.
    const coolingDown = await OpportunityRepository.findCoolingDown(
      projectId,
      fingerprint,
    );
    if (coolingDown) return { created: false };

    const result = await OpportunityRepository.create({
      ...scope,
      insightId: insight.id,
      title: output.title,
      description: output.description,
      category: insight.category ?? undefined,
      goalIds: output.goalIndexes
        .map((i) => goals[i]?.id)
        .filter((id): id is string => Boolean(id)),
      valueScore: output.valueScore,
      urgencyScore: output.urgencyScore,
      confidenceScore: output.confidenceScore,
      riskScore: output.riskScore,
      evidenceStrength: output.evidenceStrength,
      timeWindowStart: output.timeWindowDays ? new Date() : undefined,
      timeWindowEnd: output.timeWindowDays
        ? new Date(Date.now() + output.timeWindowDays * 86_400_000)
        : undefined,
      fingerprint,
      isMock,
    });

    if (result.duplicate) return { created: false };

    await AutonomyPolicyRepository.checkAndIncrement(
      scope,
      "opportunitiesCreated",
    ).catch(() => undefined);
    await InsightRepository.transition(insight.id, projectId, "PROMOTED");
    await OpportunityRepository.transition(
      result.opportunity.id,
      projectId,
      "EVALUATED",
    );

    return { created: true, opportunityId: result.opportunity.id };
  },

  // Batch pass over EVALUATED insights across projects. Per-insight error
  // boundary: listByStatus spreads its `limit` slots across distinct
  // projects, so one insight that fails to evaluate must not also block
  // every OTHER project's insight in the same batch.
  async evaluatePromotedInsights(limit = 10): Promise<number> {
    const insights = await InsightRepository.listByStatus("NEW", limit);
    let created = 0;
    for (const insight of insights) {
      // Paused project — skip without processing, exactly like
      // signal-universe.ts's own scan skip. Try again next tick.
      if (!(await isProjectAgencyActive(insight.projectId))) continue;

      try {
        const result = await this.evaluateInsight(
          insight.id,
          insight.projectId,
        );
        if (result.created) created += 1;
      } catch (error) {
        console.error(
          `[opportunity-engine] evaluateInsight failed for insight ${insight.id} (${insight.title}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return created;
  },
};
