import "server-only";

import {
  Prisma,
  type AgencyDecisionType,
  type CreativeLens,
} from "@prisma/client";

import { taskFingerprint } from "@/server/agency/fingerprint";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { GoalEngine } from "@/server/agency/goals/goal-engine";
import { TaskPlanner } from "@/server/commands/task-planner";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { AgencyDecisionRepository } from "@/server/repositories/agency-decision.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";
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

// IDEA_TRANSITIONS (state-machine/transitions.ts) allows exactly one exit
// from PLANNING: -> ACTIVE. Nothing ever re-lists or retries a PLANNING
// idea, and IdeaRepository.countActive() counts PLANNING against the
// project's maxActiveIdeas cap — so an Idea that reaches PLANNING and then
// hits a thrown error (autonomy budget cap, work-plan builder failure,
// planner failure) is stranded there permanently, silently eating a slot
// forever. The fix is to never move the Idea past SHORTLISTED until the
// risky operation it's paying for (the plan/task that justifies PLANNING)
// has actually succeeded — at which point this walks it through
// APPROVED -> PLANNING -> ACTIVE in one shot, exactly as before.
async function advanceIdeaToActive(
  ideaId: string,
  projectId: string,
  extra?: { workPlanId?: string },
): Promise<void> {
  await IdeaRepository.transition(ideaId, projectId, "APPROVED");
  await IdeaRepository.transition(ideaId, projectId, "PLANNING");
  await IdeaRepository.transition(ideaId, projectId, "ACTIVE", extra);
}

const APPROVE_THRESHOLD = 0.45;
const BACKLOG_THRESHOLD = 0.3;

// Deterministic visual-need signal: idea.lens is a structured Prisma enum,
// far more reliable than the LLM's free-text departmentsInvolved output
// (idea-generation.ts's schema doesn't constrain it to a known set). Lenses
// that inherently produce visual/social content route through CREATIVE
// regardless of what the LLM named — mirrors the lens->department intent
// idea-generation.ts's buildMock lensDepartments table already encodes for
// BRAND/CULTURE/SOCIAL/EXPERIENCE/OFFLINE.
const VISUAL_LENSES = new Set<CreativeLens>([
  "BRAND",
  "CULTURE",
  "SOCIAL",
  "EXPERIENCE",
  "OFFLINE",
]);

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

    const needsVisual =
      (idea.lens !== null && VISUAL_LENSES.has(idea.lens)) ||
      departments.includes("CREATIVE");
    if (needsVisual && !departments.includes("CREATIVE")) {
      departments.push("CREATIVE");
    }

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

    // Concurrency backpressure (spec section 37): independent of the daily
    // tasksCreated counter below, this caps how much SYSTEM-created work can
    // be in flight for the project at once. Checked here — after scoring
    // and the AgencyDecision is recorded, before either execute path
    // (CREATE_TASK or CREATE_MULTI_DEPARTMENT_PLAN) commits to new work —
    // so a busy project's idea is left SHORTLISTED exactly like a BACKLOG
    // decision, and decideShortlisted naturally re-decides it once older
    // tasks complete and the cooldown window passes.
    if (!policy.unlimitedMode) {
      const activeSystemTasks =
        await TaskRepository.countActiveSystemTasks(projectId);
      if (activeSystemTasks >= policy.maxConcurrentSystemTasks) {
        return decision;
      }
    }

    // Execute path: goal linkage is mandatory for autonomous work. If the
    // opportunity itself has no goal (opportunityEvaluationDef's LLM found
    // no matching ProjectGoal), fall back to the project's own highest-
    // priority active/approved goal instead of hard-failing — previously
    // assertGoalsLinked threw here AFTER the AgencyDecision above was
    // already recorded, so the idea looked "decided" but never got a
    // WorkPlan/task, and the fingerprint-based cooldown then silently
    // blocked any retry for policy.taskCooldownHours. A blind default is
    // still recorded as a real decision (traceable via this rationale),
    // not a silent no-op. Only genuinely goal-less projects (setup not
    // finished) still hit the hard failure below.
    let goalIds = opportunity?.goalIds ?? [];
    if (goalIds.length === 0) {
      const fallbackGoals =
        await ProjectGoalRepository.listActiveOrApproved(projectId);
      if (fallbackGoals[0]) {
        goalIds = [fallbackGoals[0].id];
        console.warn(
          `[agency-director] idea ${idea.id} (${idea.title}): opportunity had no linked goal, auto-assigned fallback goal ${fallbackGoals[0].id}`,
        );
      }
    }
    GoalEngine.assertGoalsLinked(goalIds, `idea ${idea.title}`);

    if (decisionType === "CREATE_MULTI_DEPARTMENT_PLAN" && workPlanBuilder) {
      // Deliberately called while the Idea is still SHORTLISTED (see
      // advanceIdeaToActive above): if workPlanBuilder throws, the Idea
      // must not already be at PLANNING, so nothing here catches the
      // error — it propagates to the caller's own per-idea try/catch
      // (agency-wiring.ts's INITIAL_WORK_PLAN runner, decideShortlisted
      // below), leaving the Idea intact and eligible to be re-decided on a
      // later tick instead of stranded.
      const { workPlanId, taskIds } = await workPlanBuilder({
        ideaId,
        projectId,
        decisionId: decision.id,
        departments,
      });
      await advanceIdeaToActive(ideaId, projectId, { workPlanId });
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

    // Single task: route to the concept's most relevant capability.
    // CREATE_CAMPAIGN_BRIEF is the universal "start the work" capability for
    // a single-department idea — except when the idea needs visual output,
    // where routing to the text-only brief silently never produced an image
    // (this branch never looked at `departments`/lens at all). Visual-need
    // ideas go straight to CREATE_SOCIAL_CREATIVE instead.
    const capability: "CREATE_SOCIAL_CREATIVE" | "CREATE_CAMPAIGN_BRIEF" =
      needsVisual ? "CREATE_SOCIAL_CREATIVE" : "CREATE_CAMPAIGN_BRIEF";
    const department = DepartmentRouter.ownerOf(capability) ?? "COPY_CONTENT";

    // Task fingerprint + cooldown gate (noise control) — keyed by idea.id,
    // NOT idea.title. This is a per-idea re-trigger guard (stop the SAME
    // idea from spawning a new task on every continuous-engine tick), not a
    // cross-idea content dedup: two DIFFERENT ideas routinely produce
    // similar or identical titles (mock/templated reasoning output does
    // this often — confirmed via CI's agency-loop.integration.test.ts,
    // where several distinct ideas shared the literal title "Landing page
    // content..."). Fingerprinting on title text made those collide as if
    // they were the same idea, silently dropping every task past the
    // first — undercounting the resulting work plan and occasionally
    // racing the P2002 catch below. idea.id is unique per idea by
    // definition, so same-idea reprocessing is still caught, and different
    // ideas never collide regardless of title similarity.
    const fingerprint = taskFingerprint({
      capability,
      department,
      subject: idea.id,
    });
    const since = new Date(Date.now() - policy.taskCooldownHours * 3600_000);
    const duplicate = await TaskRepository.findRecentByFingerprint(
      projectId,
      fingerprint,
      since,
    );
    if (duplicate) {
      await advanceIdeaToActive(ideaId, projectId);
      return decision;
    }

    try {
      await AutonomyPolicyRepository.checkAndIncrement(scope, "tasksCreated");
    } catch {
      // Cap reached — decision recorded, task deferred. The Idea is still
      // SHORTLISTED here (advanceIdeaToActive only runs once a task/plan
      // actually gets created below), so a later tick can re-decide it
      // instead of it being stranded at PLANNING forever.
      return decision;
    }

    let planned: Awaited<ReturnType<typeof TaskPlanner.planForCapability>>;
    try {
      planned = await TaskPlanner.planForCapability({
        ...scope,
        capability,
        request: `${idea.title}: ${idea.description.slice(0, 200)}`,
        createdByType: "SYSTEM",
        departmentKey: department,
        goalIds,
        fingerprint,
        sourceDecisionId: decision.id,
      });
    } catch (error) {
      // The findRecentByFingerprint check above is check-then-act, not
      // atomic: two ideas that resolve to the same fingerprint (mock/
      // templated titles routinely do — see the "Landing page content..."
      // collisions this was found from) can both pass it before either
      // commits, and the loser hits the DB's real (projectId, fingerprint)
      // unique constraint here. Every other fingerprint-deduped repository
      // in this codebase (signal/insight/opportunity/agency-trigger) treats
      // a P2002 on that constraint as "already exists," not an error — Task
      // creation is the one path that didn't, so the race surfaced as a
      // silently-dropped task instead of a graceful duplicate. Same
      // handling as the pre-check's duplicate branch above.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        await advanceIdeaToActive(ideaId, projectId);
        return decision;
      }
      throw error;
    }

    await advanceIdeaToActive(ideaId, projectId);
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
      // Paused-project guard (audit scenario L): a PAUSED project's ideas
      // are skipped silently — no error, no AgencyDecision — so a resumed
      // project simply picks the idea back up on a later tick instead of
      // it being treated as a failure.
      if (!(await isProjectAgencyActive(idea.projectId))) continue;
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
