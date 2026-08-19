import "server-only";

import type { AgencyDecisionType, CreativeLens } from "@prisma/client";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { GoalEngine } from "@/server/agency/goals/goal-engine";
import { TaskPlanner } from "@/server/commands/task-planner";
import { AgencyDecisionRepository } from "@/server/repositories/agency-decision.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { TaskRepository } from "@/server/repositories/task.repository";

import { resolveWeights, scoreItem } from "./next-best-action";

// The highest operational authority (spec sections 24-25): a deterministic
// domain service. Reasoning informs the inputs (scores, council verdicts);
// the DECISION itself is computed here, recorded as an AgencyDecision, and
// only then does work get created — through TaskPlanner, never directly.
//
// Wave 3 scope: REJECT / BACKLOG / CREATE_TASK on shortlisted single-
// department ideas. CREATE_CAMPAIGN / CREATE_MULTI_DEPARTMENT_PLAN land in
// Wave 4 via the injected work-plan builder.

type PlanBuilder = (input: {
  ideaId: string;
  projectId: string;
  decisionId: string;
  departments: string[];
}) => Promise<{ workPlanId: string; taskIds: string[] }>;

let workPlanBuilder: PlanBuilder | null = null;

export function registerWorkPlanBuilder(builder: PlanBuilder): void {
  workPlanBuilder = builder;
}

const APPROVE_THRESHOLD = 0.45;
const BACKLOG_THRESHOLD = 0.3;

export const AgencyDirector = {
  async decideOnIdea(ideaId: string, projectId: string) {
    const idea = await IdeaRepository.findByIdInProject(ideaId, projectId);
    if (!idea || idea.status !== "SHORTLISTED") return null;

    const scope = {
      workspaceId: idea.workspaceId,
      projectId: idea.projectId,
      brandId: idea.brandId,
    };

    const policy = await AutonomyPolicyRepository.getOrCreate(scope);

    // Cooldown gate: a BACKLOG'd idea never leaves SHORTLISTED, so without
    // this it gets re-selected by decideShortlisted() on every continuous-
    // engine tick (every 3s) and writes a fresh AgencyDecision row each
    // time — unbounded growth with no upper bound. Mirrors the
    // fingerprint+cooldown gate CREATE_TASK already uses below.
    const recentDecision =
      await AgencyDecisionRepository.findMostRecentForSubject("IDEA", ideaId);
    if (
      recentDecision &&
      recentDecision.createdAt.getTime() >
        Date.now() - policy.taskCooldownHours * 3600_000
    ) {
      return null;
    }

    const opportunity = idea.opportunityId
      ? await OpportunityRepository.findByIdInProject(
          idea.opportunityId,
          projectId,
        )
      : null;

    const weights = resolveWeights(policy.scoringWeights);

    const councilAvg =
      idea.councilEvaluations.length > 0
        ? idea.councilEvaluations.reduce((a, e) => a + e.overallScore, 0) /
          idea.councilEvaluations.length /
          10
        : 0.5;

    const inWindow =
      !opportunity?.timeWindowEnd ||
      opportunity.timeWindowEnd.getTime() > Date.now();

    const { score, breakdown } = scoreItem(
      {
        impact: opportunity?.valueScore ?? councilAvg,
        goalAlignment: (opportunity?.goalIds.length ?? 0) > 0 ? 1 : 0,
        urgency: opportunity?.urgencyScore ?? 0.5,
        evidence: opportunity?.evidenceStrength ?? 0.5,
        confidence: opportunity?.confidenceScore ?? 0.5,
        timing: inWindow ? 1 : 0.2,
        originality: councilAvg,
        cost: 0.3,
        effort: 0.4,
        risk: opportunity?.riskScore ?? 0.3,
      },
      weights,
    );

    await IdeaRepository.transition(ideaId, projectId, "SHORTLISTED", {
      nbaScore: score,
    });

    // Decision rules (deterministic):
    // - Below backlog threshold or expired window -> REJECT
    // - Between thresholds -> BACKLOG
    // - Above threshold, multi-department concept + builder present ->
    //   CREATE_MULTI_DEPARTMENT_PLAN (Wave 4); otherwise CREATE_TASK.
    const concept = (idea.concept ?? {}) as {
      departmentsInvolved?: string[];
    };
    const departments = concept.departmentsInvolved ?? [];

    let decisionType: AgencyDecisionType;
    if (score < BACKLOG_THRESHOLD || !inWindow) {
      decisionType = "REJECT";
    } else if (score < APPROVE_THRESHOLD) {
      decisionType = "BACKLOG";
    } else if (departments.length > 1 && workPlanBuilder) {
      decisionType = "CREATE_MULTI_DEPARTMENT_PLAN";
    } else {
      decisionType = "CREATE_TASK";
    }

    const decision = await AgencyDecisionRepository.create({
      ...scope,
      subjectType: "IDEA",
      subjectId: ideaId,
      decision: decisionType,
      rationale: `NBA score ${score} (thresholds: backlog ${BACKLOG_THRESHOLD}, approve ${APPROVE_THRESHOLD}); councils avg ${Math.round(councilAvg * 100) / 100}; departments: ${departments.join(", ") || "single"}`,
      scoreBreakdown: breakdown,
      inputsSnapshot: {
        ideaTitle: idea.title,
        lens: idea.lens,
        opportunityTitle: opportunity?.title,
        councilRecommendations: idea.councilEvaluations.map((e) => ({
          council: e.councilType,
          recommendation: e.recommendation,
          overallScore: e.overallScore,
        })),
      },
      isMock: idea.isMock,
    });

    if (decisionType === "REJECT") {
      await IdeaRepository.transition(ideaId, projectId, "REJECTED");
      return decision;
    }
    if (decisionType === "BACKLOG") {
      // Idea stays SHORTLISTED with its score — future ticks may re-decide
      // when the landscape changes.
      return decision;
    }

    // Execute path: goal linkage is mandatory for autonomous work.
    const goalIds = opportunity?.goalIds ?? [];
    GoalEngine.assertGoalsLinked(goalIds, `idea ${idea.title}`);

    await IdeaRepository.transition(ideaId, projectId, "APPROVED");
    await IdeaRepository.transition(ideaId, projectId, "PLANNING");

    if (decisionType === "CREATE_MULTI_DEPARTMENT_PLAN" && workPlanBuilder) {
      const { workPlanId, taskIds } = await workPlanBuilder({
        ideaId,
        projectId,
        decisionId: decision.id,
        departments,
      });
      await IdeaRepository.transition(ideaId, projectId, "ACTIVE", {
        workPlanId,
      });
      await AgencyDecisionRepository.create({
        ...scope,
        subjectType: "IDEA",
        subjectId: ideaId,
        decision: "CREATE_MULTI_DEPARTMENT_PLAN",
        rationale: `Work plan ${workPlanId} created with ${taskIds.length} tasks`,
        workPlanId,
        taskIds,
        isMock: idea.isMock,
      });
      return decision;
    }

    // Single task: route to the concept's first department's most relevant
    // capability — CREATE_CAMPAIGN_BRIEF as the universal "start the work"
    // capability for a single-department idea.
    const capability = "CREATE_CAMPAIGN_BRIEF" as const;
    const department = DepartmentRouter.ownerOf(capability) ?? "COPY_CONTENT";

    // Task fingerprint + cooldown gate (noise control).
    const fingerprint = taskFingerprint({
      capability,
      department,
      subject: idea.title,
    });
    const since = new Date(Date.now() - policy.taskCooldownHours * 3600_000);
    const duplicate = await TaskRepository.findRecentByFingerprint(
      projectId,
      fingerprint,
      since,
    );
    if (duplicate) {
      await IdeaRepository.transition(ideaId, projectId, "ACTIVE");
      return decision;
    }

    try {
      await AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated");
    } catch {
      return decision; // Cap reached — decision recorded, task deferred.
    }

    const planned = await TaskPlanner.planForCapability({
      ...scope,
      capability,
      request: `${idea.title}: ${idea.description.slice(0, 200)}`,
      createdByType: "SYSTEM",
      departmentKey: department,
      goalIds,
      fingerprint,
      sourceDecisionId: decision.id,
    });

    await IdeaRepository.transition(ideaId, projectId, "ACTIVE");
    await AgencyDecisionRepository.create({
      ...scope,
      subjectType: "IDEA",
      subjectId: ideaId,
      decision: "CREATE_TASK",
      rationale: `Task ${planned.task.id} created for department ${department}`,
      taskIds: [planned.task.id],
      isMock: idea.isMock,
    });

    return decision;
  },

  // Batch pass: shortlisted ideas that already have council evaluations.
  async decideShortlisted(limit = 5): Promise<number> {
    const ideas = await IdeaRepository.listByStatus("SHORTLISTED", limit);
    let decided = 0;
    for (const idea of ideas) {
      if (idea.councilEvaluations.length === 0) continue;
      // Per-idea error boundary, same as the INITIAL_WORK_PLAN setup-stage
      // runner (agency-wiring.ts): one idea that can't be decided (e.g. its
      // opportunity has no linked ProjectGoal — GoalEngine.assertGoalsLinked)
      // must not abort the whole batch. Since listByStatus now spreads its
      // `limit` slots across distinct projects, one bad idea here would
      // otherwise also block every OTHER project's idea in the same batch,
      // not just its own.
      try {
        const result = await this.decideOnIdea(idea.id, idea.projectId);
        if (result) decided += 1;
      } catch (error) {
        console.error(
          `[agency-director] decideOnIdea failed for idea ${idea.id} (${idea.title}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return decided;
  },
};

export type { CreativeLens };
