import "server-only";

// Side-effect wiring module: registers the late setup-stage runners and the
// intelligence pipeline steps into the orchestrator/engine extension points.
// Imported once by ExecutionWorker so a single import activates the full
// Agency OS loop without creating module cycles.

import { isAgencyFocusMode } from "@/server/agency/agency-focus";
import { CouncilEngine } from "@/server/agency/council/council-engine";
import { AgencyLoopHeartbeat } from "@/server/agency/continuous/agency-loop-heartbeat";
import {
  AgencyDirector,
  registerWorkPlanBuilder,
} from "@/server/agency/director/agency-director";
import { WorkHandoffEngine } from "@/server/agency/handoffs/work-handoff-engine";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import { IdeaRefill } from "@/server/ideas/idea-refill";
import { WeeklyPlanDraft } from "@/server/agency/content/weekly-plan-draft";
import { WeeklyPlanProduce } from "@/server/agency/content/weekly-plan-produce";
import { legacyAgencyLoopMode } from "@/server/agency/legacy-loop";
import { IntelligenceEngine } from "@/server/agency/intelligence/intelligence-engine";
import { WebSignalScanner } from "@/server/agency/intelligence/web-signal-scanner";
import { OpportunityEngine } from "@/server/agency/opportunities/opportunity-engine";
import { registerSetupStageRunner } from "@/server/agency/setup/project-setup-orchestrator";
import {
  registerAgencyTickStep,
  registerTaskCompletedHandler,
  registerTaskTerminalHandler,
} from "@/server/agency/continuous/continuous-agency-engine";
import { LearningEngine } from "@/server/agency/learning/learning-engine";
import { MeasurementEngine } from "@/server/agency/measurement/measurement-engine";
import { StrategyEngine } from "@/server/agency/strategy/strategy-service";
import { MetaAdSetChainRelay } from "@/server/agency/meta-ads/meta-adset-chain-relay";
import { MetaCampaignChainRelay } from "@/server/agency/meta-ads/meta-campaign-chain-relay";
import { CreativePublishCompletion } from "@/server/commands/creative-publish-completion";
import { GoogleAnalyticsScanner } from "@/server/agency/performance/google-analytics-scanner";
import { MetaPerformanceScanner } from "@/server/agency/performance/meta-performance-scanner";
import { WorkPlanBuilder } from "@/server/agency/work-plans/work-plan-builder";
import { WorkPlanProgressor } from "@/server/agency/work-plans/work-plan-progressor";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { InsightRepository } from "@/server/repositories/insight.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { pollTelegramApprovals } from "@/server/integrations/telegram-approval-poller";

// --- Setup stages 9-11 (spec section 5) ------------------------------------

registerSetupStageRunner("INITIAL_OPPORTUNITIES", async (scope) => {
  await IntelligenceEngine.synthesizeInsights(scope);
  const insights = await InsightRepository.listForProject(scope.projectId, {
    status: "NEW",
    limit: 10,
  });
  // Per-item error boundary — one insight's opportunity evaluation failing
  // (a malformed LLM response, a transient provider error) must not abort
  // evaluation for the other insights, nor fail this whole setup stage.
  await Promise.all(
    insights.map((insight) =>
      OpportunityEngine.evaluateInsight(insight.id, scope.projectId).catch(
        (error) => {
          console.error(
            `[agency-wiring] evaluateInsight failed for insight ${insight.id}:`,
            error instanceof Error ? error.message : error,
          );
        },
      ),
    ),
  );
});

registerSetupStageRunner("INITIAL_IDEA_PORTFOLIO", async (scope) => {
  const opportunities = await OpportunityRepository.listForProject(
    scope.projectId,
    { status: "EVALUATED", limit: 3 },
  );
  // Independent per-opportunity generation — each does its own dedup check
  // scoped to its own opportunityId+lens, no shared mutable state — so
  // there's no reason for these to run one after another. Per-item error
  // boundary (same pattern as INITIAL_WORK_PLAN's decideOnIdea below): one
  // opportunity's reasoning call failing must not abort idea generation for
  // the rest of the batch, nor fail this whole setup stage.
  await Promise.all(
    opportunities.map((opportunity) =>
      IdeaFoundry.generateForOpportunity(opportunity.id, scope.projectId, {
        postToChat: false,
      }).catch((error) => {
        console.error(
          `[agency-wiring] generateForOpportunity failed for opportunity ${opportunity.id}:`,
          error instanceof Error ? error.message : error,
        );
      }),
    ),
  );
  // Council pass over the fresh portfolio (bounded parallel batches). Same
  // per-item error boundary — one idea's council evaluation failing (e.g. a
  // malformed LLM response) must not sink the other 4 ideas in its batch.
  const raw = await IdeaRepository.listForProject(scope.projectId, {
    status: "RAW",
    limit: 20,
  });
  const BATCH = 5;
  for (let i = 0; i < raw.length; i += BATCH) {
    await Promise.all(
      raw.slice(i, i + BATCH).map((idea) =>
        CouncilEngine.evaluateIdea(idea.id, scope.projectId, {
          postToChat: false,
        }).catch((error) => {
          console.error(
            `[agency-wiring] evaluateIdea failed for idea ${idea.id} (${idea.title}):`,
            error instanceof Error ? error.message : error,
          );
        }),
      ),
    );
  }
});

registerSetupStageRunner("INITIAL_WORK_PLAN", async (scope) => {
  const shortlisted = await IdeaRepository.listForProject(scope.projectId, {
    status: "SHORTLISTED",
    limit: 10,
  });
  // Per-idea error boundary: one idea that can't be decided (e.g. its
  // opportunity has no linked ProjectGoal — GoalEngine.assertGoalsLinked)
  // must not abort the whole stage. Without this, that single idea sorts
  // first on every retry and the stage fails identically forever, since
  // nothing here ever mutates its status to move it out of the way.
  for (const idea of shortlisted) {
    if (idea.councilEvaluations.length === 0) continue;
    try {
      await AgencyDirector.decideOnIdea(idea.id, scope.projectId);
    } catch (error) {
      console.error(
        `[agency-wiring] decideOnIdea failed for idea ${idea.id} (${idea.title}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }
});

// --- Continuous loop steps (spec section 33, pipeline order) ----------------

// First step of every tick, deliberately: keeps AgencyLoopState's PAUSED
// sync fresh (see agency-loop-heartbeat.ts) before any of the engines below
// run — a later phase's per-engine pause checks will read state this step
// just wrote, not state up to one tick stale.
registerAgencyTickStep({
  name: "agency-loop-heartbeat",
  run: () => AgencyLoopHeartbeat.run(50),
});

// The Brand Brain's weekly look at the outside world (web-signal-scanner.ts):
// one web-searching call per active project a week reports competitors' moves,
// trends, cultural moments and news as sourced signals. It replaces the old
// "signal-scans" step (generic OpenClaw web research per signal category,
// SignalUniverse.runDueScans), which lost its provider with OpenClaw and only
// created tasks that failed at once.
registerAgencyTickStep({
  name: "web-signal-scan",
  run: () => WebSignalScanner.runDueScans(2),
});
// Structured, real-Meta-Insights signal source — deliberately separate
// from the weekly web scan above: this scans
// connected Meta ad accounts directly via the Marketing API on its own
// ~7h cadence and can also short-circuit straight to a Track 2 Approval
// (see performance-optimizer.ts) for high-severity findings, something a
// generic signal source never does. Placed right before signal-processing
// so PERFORMANCE signals produced this tick get scored in the same tick.
registerAgencyTickStep({
  name: "meta-ads-performance-scan",
  run: () => MetaPerformanceScanner.runDueScans(5),
});
// Same role as meta-ads-performance-scan above, for GA4/Search Console —
// SEO signals produced this tick get scored in the same tick's
// signal-processing step. See google-analytics-scanner.ts.
registerAgencyTickStep({
  name: "google-analytics-scan",
  run: () => GoogleAnalyticsScanner.runDueScans(5),
});
registerAgencyTickStep({
  name: "signal-processing",
  run: () => IntelligenceEngine.processNewSignals(20),
});
registerAgencyTickStep({
  name: "insight-synthesis",
  run: async () => {
    const projects = await IntelligenceEngine.projectsNeedingInsights(5);
    // One LLM call per project, independent of each other — in parallel.
    await Promise.all(
      projects.map((scope) => IntelligenceEngine.synthesizeInsights(scope)),
    );
    return projects.length;
  },
});
registerAgencyTickStep({
  name: "opportunity-evaluation",
  run: () => OpportunityEngine.evaluatePromotedInsights(10),
});
// The Brand Brain loop's idea step (docs/ideas.md): the idea pool is kept
// full of ready-to-make post ideas. A project someone works in, whose fresh
// post ideas fall below the low-water mark, gets one idea-engine run at most
// every few hours (idea-refill.ts), bounded by the pool size and the daily AI
// limit. The ideas are typed and born VALIDATED, out of reach of the old
// Council and Director, so this runs in every LEGACY_AGENCY_LOOP mode. It
// replaces the old daily "idea-generation" step (campaign ideas across
// creative lenses, which the posts planner could not use as they were).
registerAgencyTickStep({
  name: "idea-pool-refill",
  run: () => IdeaRefill.runDue(2),
});
// Faz 4: every Sunday evening (project time) Agentelse drafts next week's plan
// from the idea pool into a chat of its own (weekly-plan-draft.ts), unless the
// owner switched it off in Settings -> Autonomy. A draft only: saving, making
// and publishing stay the owner's taps. Works only; one lite call per project
// a week; the "nothing due" path is two queries.
registerAgencyTickStep({
  name: "weekly-plan-draft",
  run: () => WeeklyPlanDraft.runDue(2),
});
// Faz 5: once a weekly draft has sat untouched for a couple of hours,
// weekly-plan-produce.ts saves it and starts production on its own — only for
// a project whose owner opted into Settings -> Autonomy "Prepare it
// automatically" (AutonomyPolicy.weeklyAutoProduce, default off). Approving,
// scheduling and publishing stay the owner's taps exactly as they are for a
// plan produced by hand. Runs only once the old loop is wound down
// (LEGACY_AGENCY_LOOP=drain|off): with it `on`, the Council and the Director
// would also be turning the same pool ideas into work of their own.
registerAgencyTickStep({
  name: "weekly-plan-produce",
  run: async () =>
    legacyAgencyLoopMode() === "on" ? 0 : WeeklyPlanProduce.runDue(2),
});
registerAgencyTickStep({
  name: "council-evaluation",
  run: () => CouncilEngine.evaluatePendingIdeas(5),
});
registerAgencyTickStep({
  name: "director-decisions",
  run: () => AgencyDirector.decideShortlisted(5),
});

// --- Wave 4: work orchestration wiring --------------------------------------

// Director's multi-department path builds a full WorkPlan.
registerWorkPlanBuilder((input) => WorkPlanBuilder.buildForIdea(input));

// Completed tasks progress their work plan and close out their handoff.
// Handler names below are what LEGACY_AGENCY_LOOP (legacy-loop.ts) gates on and
// what the audit trail shows when one fails; the unlisted ones are real product
// features and always run.
registerTaskCompletedHandler(async (taskId) => {
  await WorkPlanProgressor.onTaskCompleted(taskId);
}, "work-plan-progression");
registerTaskCompletedHandler(async (taskId) => {
  await WorkHandoffEngine.onTaskCompleted(taskId);
}, "handoff-close-out");
// Symmetric to the COMPLETED path above — a FAILED task's work plan needs
// to know too (cascade-cancel dependents, resolve the plan to FAILED once
// every node is terminal), or the plan and any dependent task strand
// forever (see work-plan-progressor.ts's onTaskTerminal).
registerTaskTerminalHandler(async (taskId, status) => {
  await WorkPlanProgressor.onTaskTerminal(taskId, status);
}, "work-plan-terminal");
// Resumes handoffs accept() had to strand ACCEPTED (daily task-creation cap
// hit) or leave PROPOSED past its expiry — see work-handoff-engine.ts's
// progressPending, which finally gives WorkHandoffRepository.listByStatus
// the caller it never had.
registerAgencyTickStep({
  name: "handoff-progression",
  run: () => WorkHandoffEngine.progressPending(10),
});
// Self-heals a WorkPlan node task that was created READY (deferDispatch) but
// never got dispatched by the one-shot root-dispatch call in
// work-plan-builder.ts or a reactive TASK_COMPLETED/TASK_CANCELLED trigger
// (e.g. isProjectAgencyActive was transiently false at plan-creation time) —
// see work-plan-progressor.ts's sweepOrphanedReadyTasks for the staleness/
// idempotency reasoning. Without this, such a task (and everything depending
// on it) stays orphaned in READY forever.
registerAgencyTickStep({
  name: "work-plan-stale-sweep",
  run: () => WorkPlanProgressor.sweepOrphanedReadyTasks(20),
});
// Combined AdSet+Ad wizard's second-Task fan-out (see meta-adset-chain-relay.ts).
registerTaskCompletedHandler(async (taskId) => {
  await MetaAdSetChainRelay.onTaskCompleted(taskId);
}, "meta-adset-chain");
// Autonomous campaign-proposal path's Campaign->AdSet fan-out (see
// meta-campaign-chain-relay.ts) — one link earlier in the same chain as
// the relay just above, which then continues on to the Ad unchanged.
registerTaskCompletedHandler(async (taskId) => {
  await MetaCampaignChainRelay.onTaskCompleted(taskId);
}, "meta-campaign-chain");
// Flips a Creative to PUBLISHED once its publish Task completes (see
// creative-publish-completion.ts) — applies to every publish path, human
// or autonomous, not just the ones added above.
registerTaskCompletedHandler(async (taskId) => {
  await CreativePublishCompletion.onTaskCompleted(taskId);
}, "creative-publish-completion");

// --- Wave 5: measurement + learning wiring ----------------------------------

// Externally visible completed work gets a measurement plan; completed
// MEASUREMENT_CHECK tasks store their observation on the check.
registerTaskCompletedHandler(async (taskId) => {
  // Focus mode turns the measurement loop off (agency-focus.ts) — don't
  // pile up plans whose checks would all fire at once when it's re-enabled.
  if (isAgencyFocusMode()) return;
  await MeasurementEngine.planForCompletedTask(taskId);
}, "measurement-planning");
registerTaskCompletedHandler(async (taskId) => {
  await MeasurementEngine.onCheckTaskCompleted(taskId);
}, "measurement-check-result");
// Symmetric to the COMPLETED handler above — a MEASUREMENT_CHECK task
// ending FAILED/CANCELLED previously left its MeasurementCheck stuck at
// RUNNING forever (see measurement-engine.ts's onCheckTaskTerminal), which
// in turn meant its MeasurementPlan never reached COMPLETED and
// LearningEngine never saw it.
registerTaskTerminalHandler(async (taskId, status) => {
  await MeasurementEngine.onCheckTaskTerminal(taskId, status);
}, "measurement-check-terminal");

registerAgencyTickStep({
  name: "measurement-checks",
  run: () => MeasurementEngine.runDueChecks(10),
});
registerAgencyTickStep({
  name: "learning",
  run: () => LearningEngine.processCompletedMeasurements(10),
});
// Right after learning: brands with fresh BrandLearning entries this same
// tick (produced by the step above) are picked up immediately, since tick
// steps run sequentially — see continuous-agency-engine.ts.
registerAgencyTickStep({
  name: "strategy-synthesis",
  run: () => StrategyEngine.resynthesizeDue(5),
});

registerAgencyTickStep({
  name: "telegram-approval-polling",
  run: () => pollTelegramApprovals(),
});

export const AGENCY_WIRING_LOADED = true;
