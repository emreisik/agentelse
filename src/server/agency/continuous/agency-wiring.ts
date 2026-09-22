import "server-only";

// Side-effect wiring module: registers the late setup-stage runners and the
// intelligence pipeline steps into the orchestrator/engine extension points.
// Imported once by ExecutionWorker so a single import activates the full
// Agency OS loop without creating module cycles.

import { CouncilEngine } from "@/server/agency/council/council-engine";
import {
  AgencyDirector,
  registerWorkPlanBuilder,
} from "@/server/agency/director/agency-director";
import { WorkHandoffEngine } from "@/server/agency/handoffs/work-handoff-engine";
import { IdeaFoundry } from "@/server/agency/ideas/idea-foundry";
import { IntelligenceEngine } from "@/server/agency/intelligence/intelligence-engine";
import { OpportunityEngine } from "@/server/agency/opportunities/opportunity-engine";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
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
      IdeaFoundry.generateForOpportunity(opportunity.id, scope.projectId).catch(
        (error) => {
          console.error(
            `[agency-wiring] generateForOpportunity failed for opportunity ${opportunity.id}:`,
            error instanceof Error ? error.message : error,
          );
        },
      ),
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
        CouncilEngine.evaluateIdea(idea.id, scope.projectId).catch((error) => {
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

registerAgencyTickStep({
  name: "signal-scans",
  run: () => SignalUniverse.runDueScans(10),
});
// Structured, real-Meta-Insights signal source — deliberately separate
// from SignalUniverse.runDueScans (which fans out generic OpenClaw web
// research per SignalCategory cadence, see scan-cadence.ts): this scans
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
    for (const scope of projects) {
      await IntelligenceEngine.synthesizeInsights(scope);
    }
    return projects.length;
  },
});
registerAgencyTickStep({
  name: "opportunity-evaluation",
  run: () => OpportunityEngine.evaluatePromotedInsights(10),
});
registerAgencyTickStep({
  name: "idea-generation",
  // 3 was too tight now that generateForTopOpportunities spreads its slots
  // across distinct projects (see idea-foundry.ts): with only a handful of
  // projects ever competing at once, a small limit still let one or two
  // old, large backlogs occupy most of the slots every tick and left
  // whichever project ranked last (newest createdAt) waiting indefinitely.
  // 10 matches opportunity-evaluation's limit just below, the structurally
  // closest sibling step (also one LLM call per candidate).
  run: () => IdeaFoundry.generateForTopOpportunities(10),
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
registerTaskCompletedHandler(async (taskId) => {
  await WorkPlanProgressor.onTaskCompleted(taskId);
});
registerTaskCompletedHandler(async (taskId) => {
  await WorkHandoffEngine.onTaskCompleted(taskId);
});
// Symmetric to the COMPLETED path above — a FAILED task's work plan needs
// to know too (cascade-cancel dependents, resolve the plan to FAILED once
// every node is terminal), or the plan and any dependent task strand
// forever (see work-plan-progressor.ts's onTaskTerminal).
registerTaskTerminalHandler(async (taskId, status) => {
  await WorkPlanProgressor.onTaskTerminal(taskId, status);
});
// Resumes handoffs accept() had to strand ACCEPTED (daily task-creation cap
// hit) or leave PROPOSED past its expiry — see work-handoff-engine.ts's
// progressPending, which finally gives WorkHandoffRepository.listByStatus
// the caller it never had.
registerAgencyTickStep({
  name: "handoff-progression",
  run: () => WorkHandoffEngine.progressPending(10),
});
// Combined AdSet+Ad wizard's second-Task fan-out (see meta-adset-chain-relay.ts).
registerTaskCompletedHandler(async (taskId) => {
  await MetaAdSetChainRelay.onTaskCompleted(taskId);
});
// Autonomous campaign-proposal path's Campaign->AdSet fan-out (see
// meta-campaign-chain-relay.ts) — one link earlier in the same chain as
// the relay just above, which then continues on to the Ad unchanged.
registerTaskCompletedHandler(async (taskId) => {
  await MetaCampaignChainRelay.onTaskCompleted(taskId);
});
// Flips a Creative to PUBLISHED once its publish Task completes (see
// creative-publish-completion.ts) — applies to every publish path, human
// or autonomous, not just the ones added above.
registerTaskCompletedHandler(async (taskId) => {
  await CreativePublishCompletion.onTaskCompleted(taskId);
});

// --- Wave 5: measurement + learning wiring ----------------------------------

// Externally visible completed work gets a measurement plan; completed
// MEASUREMENT_CHECK tasks store their observation on the check.
registerTaskCompletedHandler(async (taskId) => {
  await MeasurementEngine.planForCompletedTask(taskId);
});
registerTaskCompletedHandler(async (taskId) => {
  await MeasurementEngine.onCheckTaskCompleted(taskId);
});
// Symmetric to the COMPLETED handler above — a MEASUREMENT_CHECK task
// ending FAILED/CANCELLED previously left its MeasurementCheck stuck at
// RUNNING forever (see measurement-engine.ts's onCheckTaskTerminal), which
// in turn meant its MeasurementPlan never reached COMPLETED and
// LearningEngine never saw it.
registerTaskTerminalHandler(async (taskId, status) => {
  await MeasurementEngine.onCheckTaskTerminal(taskId, status);
});

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
