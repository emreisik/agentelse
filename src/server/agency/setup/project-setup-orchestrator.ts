import "server-only";

import type { ProjectStatus, SetupStage } from "@prisma/client";
import { ZodError } from "zod";

import { prisma } from "@/lib/prisma";
import {
  FOCUS_EXCLUDED_DISCOVERY,
  isAgencyFocusMode,
} from "@/server/agency/agency-focus";
import { BaselineAuditService } from "@/server/agency/audits/baseline-audit.service";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { GoalEngine } from "@/server/agency/goals/goal-engine";
import { SignalProfileService } from "@/server/agency/signals/signal-profile.service";
import { StrategyEngine } from "@/server/agency/strategy/strategy-service";
import { TaskPlanner } from "@/server/commands/task-planner";
import { ensureStandardBrowserProfiles } from "@/server/projects/browser-profiles";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ProjectRepository } from "@/server/repositories/project.repository";
import {
  SetupStateRepository,
  SETUP_STAGE_ORDER,
  nextStage,
} from "@/server/repositories/setup-state.repository";
import { SignalProfileRepository } from "@/server/repositories/signal-profile.repository";
import { nextScanAt } from "@/server/agency/signals/scan-cadence";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

import {
  DEEP_DISCOVERY_CAPABILITIES,
  DISCOVERY_COMPLETION_RATIO,
  DISCOVERY_FAILED_MESSAGE,
  DISCOVERY_STAGE_TIMEOUT_MS,
  ENRICHMENT_SKIPPED_STAGES,
  discoveryResearchRequest,
  discoveryVerdict,
  type DiscoveryVerdict,
  type SetupMode,
} from "./setup-stages";
import { DEMO_POST_STAGES, generateDemoPost } from "./demo-post-generator";

export type SetupIntake = {
  brandName: string;
  domain?: string;
  description?: string;
  assetIds?: string[];
  autoApprove?: boolean;
  // Absent means FULL, the original 12-stage onboarding (also what every setup
  // stored before modes existed reads as). See setup-stages.ts.
  mode?: SetupMode;
};

type SetupScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Stage hooks the orchestrator fills in later waves (INITIAL_OPPORTUNITIES /
// INITIAL_IDEA_PORTFOLIO / INITIAL_WORK_PLAN are wired to the intelligence
// engines in Wave 3). Keeping them as an injectable map lets those waves add
// behavior without rewriting the orchestrator.
type StageRunner = (scope: SetupScope, intake: SetupIntake) => Promise<void>;
const LATE_STAGE_RUNNERS: Partial<Record<SetupStage, StageRunner>> = {};

export function registerSetupStageRunner(
  stage: SetupStage,
  runner: StageRunner,
): void {
  LATE_STAGE_RUNNERS[stage] = runner;
}

// A raw ZodError's .message is a JSON-stringified issues array (Zod's
// default) — that used to land verbatim in the stage record and get shown
// to the user as-is (e.g. a wall of `{"origin":"number","code":"too_big",...}`
// for a reasoning-call output that failed schema validation). This collapses
// it to one readable line per issue; the full error is still logged and
// re-thrown for server-side diagnostics.
function formatStageError(error: unknown): string {
  if (error instanceof ZodError) {
    return `Validation failed: ${error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
      .join("; ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// Each of the 12 linear stages costs at most 2 advance() calls (PENDING ->
// RUNNING+runStage, then RUNNING -> COMPLETED+pointer move); a FAILED retry
// adds one more call. This gives real headroom to walk every stage within a
// single tick without being unbounded.
const MAX_ADVANCE_STEPS_PER_PROJECT = SETUP_STAGE_ORDER.length * 2 + 6;
// Real backstop, not the step count above: DEEP_DISCOVERY/BASELINE_AUDITS
// can each take real wall-clock seconds even with no bugs. Caps how long one
// project's setup can hog a tick before ContinuousAgencyEngine moves on to
// its other steps (signal scans, opportunity eval, ...) and to the next
// project in this same advanceAll batch.
const PER_PROJECT_SETUP_BUDGET_MS = 45_000;

// attemptCount was tracked but never capped — a stage whose failure cause is
// permanent (bad provider config, a persistently invalid LLM response) used
// to retry identically forever, every tick, silently burning a reasoning
// budget slot each time with no "give up" state and no user-facing recourse
// beyond the misleading "the system will retry automatically" message.
// Mirrors execution-worker.ts's own MAX_ATTEMPTS convention. Automatic
// (tick-driven) retries stop once this is hit; retryStageNow (a manual,
// user-initiated retry) is exempt so the user always has a way to try again.
export const MAX_STAGE_ATTEMPTS = 5;

// Activation used to only transition from PROFILE_REVIEW to ACTIVE. If the
// project was in a different intermediate status (e.g. NEEDS_INFORMATION
// left over from the removed legacy wizard), the transition was silently
// skipped — setup showed as "activated" but the project never became
// ACTIVE, and since the continuous agency loop and signal scans require
// ACTIVE, the system never ran at all.
// We now walk the legal path in the state machine step by step to reach ACTIVE.
const PATH_TO_ACTIVE: Partial<Record<ProjectStatus, ProjectStatus[]>> = {
  CREATED: ["DISCOVERY", "PROFILE_REVIEW", "ACTIVE"],
  DISCOVERY: ["PROFILE_REVIEW", "ACTIVE"],
  NEEDS_INFORMATION: ["PROFILE_REVIEW", "ACTIVE"],
  PROFILE_REVIEW: ["ACTIVE"],
  NEEDS_ASSESSMENT: ["PROFILE_REVIEW", "ACTIVE"],
  STRATEGY: ["ACTIVE"],
  PAUSED: ["ACTIVE"],
};

async function activateProjectRow(scope: SetupScope): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: scope.projectId },
    select: { status: true },
  });
  if (!project || project.status === "ACTIVE") return;

  for (const next of PATH_TO_ACTIVE[project.status] ?? []) {
    await ProjectRepository.transition(
      scope.projectId,
      scope.workspaceId,
      next,
    );
  }
}

export const ProjectSetupOrchestrator = {
  // Creates the 12-stage setup state, runs INTAKE inline, and leaves the
  // rest to advance() calls from the worker tick.
  async start(scope: SetupScope, intake: SetupIntake) {
    await AutonomyPolicyRepository.getOrCreate({
      ...scope,
      setupAutoApprove: intake.autoApprove ?? false,
    });

    // Provisioned at INTAKE because deep-discovery research tasks need the
    // PUBLIC_RESEARCH profile long before PROJECT_ACTIVATION. Idempotent: a
    // project that already got its profiles lazily (capability-router.ts)
    // keeps them.
    await ensureStandardBrowserProfiles(scope);

    const state = await SetupStateRepository.create({
      ...scope,
      intake,
    });

    // Project row follows coarsely: CREATED -> DISCOVERY (already-legal
    // transition in the existing Project state machine).
    const project = await prisma.project.findUnique({
      where: { id: scope.projectId },
      select: { status: true },
    });
    if (project?.status === "CREATED") {
      await ProjectRepository.transition(
        scope.projectId,
        scope.workspaceId,
        "DISCOVERY",
      );
    }

    // INTAKE runs inline: brand/domain persisted on Brand + intake stored.
    await SetupStateRepository.transitionStage(
      scope.projectId,
      "INTAKE",
      "RUNNING",
    );
    await prisma.brand.update({
      where: { id: scope.brandId },
      data: { name: intake.brandName },
    });
    if (intake.domain) {
      await prisma.project.update({
        where: { id: scope.projectId },
        data: { domain: intake.domain },
      });
    }
    await SetupStateRepository.transitionStage(
      scope.projectId,
      "INTAKE",
      "COMPLETED",
      { output: { brandName: intake.brandName, domain: intake.domain } },
    );
    await SetupStateRepository.setCurrentStage(
      scope.projectId,
      "DEEP_DISCOVERY",
    );

    await AuditLogRepository.record({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      actorType: "SYSTEM",
      action: "setup.started",
      entityType: "ProjectSetupState",
      entityId: state.id,
    });

    return state;
  },

  // Advances one project's setup by at most one stage-step per call. Called
  // by the worker tick; also safe to call directly (tests, actions).
  async advance(projectId: string): Promise<{
    stage: SetupStage;
    status: string;
    advanced: boolean;
  }> {
    const state = await SetupStateRepository.findByProject(projectId);
    if (!state || state.activatedAt) {
      return {
        stage: "PROJECT_ACTIVATION",
        status: "COMPLETED",
        advanced: false,
      };
    }

    const scope: SetupScope = {
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      brandId: state.brandId,
    };
    const intake = state.intake as SetupIntake;
    const stage = state.currentStage;
    const record = state.stageRecords.find((r) => r.stage === stage);
    if (!record) {
      return { stage, status: "MISSING", advanced: false };
    }

    if (record.status === "PENDING") {
      // An enrichment skips the stages that only fed the legacy agency
      // pipeline. SKIPPED counts as done everywhere (the progress widget, the
      // setup-status route), and the pointer moves on next call, like any
      // finished stage.
      if (
        intake.mode === "ENRICHMENT" &&
        ENRICHMENT_SKIPPED_STAGES.has(stage)
      ) {
        await SetupStateRepository.transitionStage(projectId, stage, "SKIPPED");
        return { stage, status: "SKIPPED", advanced: true };
      }
      await SetupStateRepository.transitionStage(projectId, stage, "RUNNING");
      await this.runStage(scope, intake, stage);
      return { stage, status: "RUNNING", advanced: true };
    }

    if (record.status === "RUNNING") {
      const verdict = await this.stageVerdict(scope, stage);
      if (verdict === "FAILED") {
        // Was: stayed RUNNING forever. As FAILED it gets the normal treatment:
        // automatic retries up to MAX_STAGE_ATTEMPTS, then the manual retry.
        await SetupStateRepository.transitionStage(projectId, stage, "FAILED", {
          error: DISCOVERY_FAILED_MESSAGE,
        });
        return { stage, status: "FAILED", advanced: true };
      }
      if (verdict === "WAIT") return { stage, status: "RUNNING", advanced: false };

      const waits = await this.stageWaitsForClient(scope, intake, stage);
      if (waits) {
        await SetupStateRepository.transitionStage(
          projectId,
          stage,
          "WAITING_CLIENT",
        );
        return { stage, status: "WAITING_CLIENT", advanced: true };
      }

      await this.completeStage(scope, stage, intake);
      return { stage, status: "COMPLETED", advanced: true };
    }

    if (record.status === "WAITING_CLIENT") {
      // Stays parked until submitClientDecision flips it.
      return { stage, status: "WAITING_CLIENT", advanced: false };
    }

    if (record.status === "FAILED") {
      if (record.attemptCount >= MAX_STAGE_ATTEMPTS) {
        // Automatic retries are capped — stop silently re-burning a
        // reasoning budget slot every tick on a cause that isn't clearing
        // on its own. The stage stays FAILED; retryStageNow (manual, from
        // the setup UI) can still move it.
        return { stage, status: "FAILED", advanced: false };
      }
      await SetupStateRepository.transitionStage(projectId, stage, "RUNNING");
      await this.runStage(scope, intake, stage);
      return { stage, status: "RETRYING", advanced: true };
    }

    // COMPLETED/SKIPPED current stage — move the pointer.
    const next = nextStage(stage);
    if (next) {
      await SetupStateRepository.setCurrentStage(projectId, next);
      return { stage: next, status: "PENDING", advanced: true };
    }
    return { stage, status: "COMPLETED", advanced: false };
  },

  // Worker entry: advance all unfinished setups. Each project's own stages
  // are inherently sequential (stage N+1 reads stage N's DB output — e.g.
  // BASELINE_AUDITS reads the BRAND_CONSTITUTION output), so within one
  // project advance() calls stay a simple loop. Different projects have no
  // such dependency, so they advance concurrently — this is what lets one
  // project's setup finish inside a single tick instead of trickling
  // through one extra 3s tick per stage.
  async advanceAll(limit = 5): Promise<number> {
    const states = await SetupStateRepository.listUnfinished(limit);
    const results = await Promise.all(
      states.map((state) => this.advanceOneProject(state.projectId)),
    );
    return results.reduce((sum, n) => sum + n, 0);
  },

  async advanceOneProject(projectId: string): Promise<number> {
    let advanced = 0;
    const deadline = Date.now() + PER_PROJECT_SETUP_BUDGET_MS;
    for (let i = 0; i < MAX_ADVANCE_STEPS_PER_PROJECT; i += 1) {
      if (Date.now() > deadline) break;
      const result = await this.advance(projectId);
      if (result.advanced) advanced += 1;
      else break;
    }
    return advanced;
  },

  // Client decision entry (approve goals / work plan) — flips the
  // WAITING_CLIENT stage to COMPLETED after applying the decision.
  async submitClientDecision(
    projectId: string,
    stage: SetupStage,
    decision: { approve: boolean; approvedByUserId?: string },
  ): Promise<void> {
    const state = await SetupStateRepository.findByProject(projectId);
    if (!state) return;
    const scope: SetupScope = {
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      brandId: state.brandId,
    };

    if (stage === "GOAL_GENERATION" && decision.approve) {
      await GoalEngine.approveAll(projectId, "USER", decision.approvedByUserId);
    }

    await this.completeStage(scope, stage, state.intake as SetupIntake);
  },

  // Manual, user-initiated retry of the current FAILED stage — the escape
  // hatch for a user who doesn't want to wait for (or has exhausted)
  // automatic tick-driven retries. Deliberately does NOT check
  // MAX_STAGE_ATTEMPTS: an automatic cap protects against silently burning
  // budget forever on a cause that isn't clearing on its own, but a human
  // explicitly asking to try again should always be able to.
  async retryStageNow(projectId: string): Promise<void> {
    const state = await SetupStateRepository.findByProject(projectId);
    if (!state) return;
    const stage = state.currentStage;
    const record = state.stageRecords.find((r) => r.stage === stage);
    if (!record || record.status !== "FAILED") return;

    const scope: SetupScope = {
      workspaceId: state.workspaceId,
      projectId: state.projectId,
      brandId: state.brandId,
    };
    const intake = state.intake as SetupIntake;

    await SetupStateRepository.transitionStage(projectId, stage, "RUNNING");
    await this.runStage(scope, intake, stage);
  },

  // --- stage internals -----------------------------------------------------

  async runStage(
    scope: SetupScope,
    intake: SetupIntake,
    stage: SetupStage,
  ): Promise<void> {
    try {
      switch (stage) {
        case "DEEP_DISCOVERY": {
          const policy = await AutonomyPolicyRepository.getOrCreate(scope);
          // Focus mode (agency-focus.ts) drops non-social/ads research.
          const capabilities = isAgencyFocusMode()
            ? DEEP_DISCOVERY_CAPABILITIES.filter(
                (capability) => !FOCUS_EXCLUDED_DISCOVERY.has(capability),
              )
            : DEEP_DISCOVERY_CAPABILITIES;
          const wave = capabilities.slice(
            0,
            Math.max(policy.maxConcurrentResearchTasks, 1) * 3,
          );
          await Promise.all(
            wave.map((capability) =>
              TaskPlanner.planForCapability({
                ...scope,
                capability,
                request: discoveryResearchRequest(
                  capability,
                  intake.brandName,
                  intake.domain,
                ),
                createdByType: "SYSTEM",
              }),
            ),
          );
          break;
        }
        case "BRAND_CONSTITUTION": {
          await ConstitutionService.synthesize({
            ...scope,
            brandName: intake.brandName,
            domain: intake.domain,
            description: intake.description,
            logoAssetIds: intake.assetIds,
          });
          // Best-effort v1 strategy so a new project never shows an empty
          // Brand Brain — a failure here must not fail the stage, since the
          // constitution (this stage's actual deliverable) already
          // succeeded. Goals don't exist yet at this point in setup
          // (GOAL_GENERATION runs later); StrategyEngine handles that.
          try {
            await StrategyEngine.synthesize({
              ...scope,
              brandName: intake.brandName,
            });
          } catch (error) {
            console.error(
              `[project-setup] strategy synthesis failed for project ${scope.projectId}:`,
              error instanceof Error ? error.message : error,
            );
          }
          // Coarse project status: DISCOVERY -> PROFILE_REVIEW.
          const project = await prisma.project.findUnique({
            where: { id: scope.projectId },
            select: { status: true },
          });
          if (project?.status === "DISCOVERY") {
            await ProjectRepository.transition(
              scope.projectId,
              scope.workspaceId,
              "PROFILE_REVIEW",
            );
          }
          break;
        }
        case "SIGNAL_PROFILE": {
          await SignalProfileService.generateForProject(scope);
          break;
        }
        case "BASELINE_AUDITS": {
          await BaselineAuditService.generateAll(scope);
          break;
        }
        case "GOAL_GENERATION": {
          await GoalEngine.generateForProject({
            ...scope,
            brandName: intake.brandName,
            description: intake.description,
          });
          break;
        }
        case "AGENCY_CONFIGURATION": {
          await DepartmentRouter.recommendModes(scope);
          break;
        }
        case "AUTONOMY_CONFIGURATION": {
          // Policy row already exists (created at start); this stage is the
          // hook where recommended caps/weights could be tuned later.
          await AutonomyPolicyRepository.getOrCreate(scope);
          break;
        }
        case "PROJECT_ACTIVATION": {
          await activateProjectRow(scope);
          // Arm signal scans for every non-OFF profile.
          const profiles = await SignalProfileRepository.listForProject(
            scope.projectId,
          );
          for (const profile of profiles) {
            const due = nextScanAt(profile.intensity);
            if (due) {
              await SignalProfileRepository.setNextScan(profile.id, due);
            }
          }
          // markActivated happens in completeStage — flipping it here would
          // hide the project from listUnfinished before the stage record
          // ever reaches COMPLETED.
          break;
        }
        default: {
          // Late stages (INITIAL_OPPORTUNITIES / INITIAL_IDEA_PORTFOLIO /
          // INITIAL_WORK_PLAN) run their registered runner when present;
          // otherwise they are pass-through until Wave 3 wires them.
          const runner = LATE_STAGE_RUNNERS[stage];
          if (runner) await runner(scope, intake);
          break;
        }
      }
    } catch (error) {
      await SetupStateRepository.transitionStage(
        scope.projectId,
        stage,
        "FAILED",
        { error: formatStageError(error) },
      );
      throw error;
    }
  },

  // Whether a RUNNING stage is finished, failed or still going. Every stage
  // but DEEP_DISCOVERY runs synchronously inside runStage, so by the time it is
  // RUNNING and read here it is complete.
  async stageVerdict(
    scope: SetupScope,
    stage: SetupStage,
  ): Promise<DiscoveryVerdict> {
    if (stage !== "DEEP_DISCOVERY") return "COMPLETE";
    const tasks = await prisma.task.findMany({
      where: {
        projectId: scope.projectId,
        createdByType: "SYSTEM",
        capability: { in: DEEP_DISCOVERY_CAPABILITIES },
      },
      select: { status: true, createdAt: true },
    });
    return discoveryVerdict({
      tasks,
      ratio: DISCOVERY_COMPLETION_RATIO,
      timeoutMs: DISCOVERY_STAGE_TIMEOUT_MS,
    });
  },

  async isStageComplete(
    scope: SetupScope,
    stage: SetupStage,
  ): Promise<boolean> {
    return (await this.stageVerdict(scope, stage)) === "COMPLETE";
  },

  async stageWaitsForClient(
    scope: SetupScope,
    _intake: SetupIntake,
    stage: SetupStage,
  ): Promise<boolean> {
    if (stage !== "GOAL_GENERATION" && stage !== "INITIAL_WORK_PLAN") {
      return false;
    }
    const policy = await AutonomyPolicyRepository.getForProject(
      scope.projectId,
    );
    if (policy?.setupAutoApprove) {
      // Auto-approve: apply the SYSTEM approval side effect now.
      if (stage === "GOAL_GENERATION") {
        await GoalEngine.approveAll(scope.projectId, "SYSTEM");
      }
      return false;
    }
    return true;
  },

  async completeStage(
    scope: SetupScope,
    stage: SetupStage,
    intake: SetupIntake,
  ): Promise<void> {
    await SetupStateRepository.transitionStage(
      scope.projectId,
      stage,
      "COMPLETED",
    );
    if (stage === "PROJECT_ACTIVATION") {
      await SetupStateRepository.markActivated(scope.projectId);
    }
    const next = nextStage(stage);
    if (next) {
      await SetupStateRepository.setCurrentStage(scope.projectId, next);
    }
    await AuditLogRepository.record({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      actorType: "SYSTEM",
      action: `setup.stage.completed.${stage}`,
      entityType: "ProjectSetupState",
      entityId: scope.projectId,
    });

    // Best-effort demo-post preview (see demo-post-generator.ts) — awaited
    // (not detached) so it isn't dropped if this runs inside a short-lived
    // worker tick, but wrapped in try/catch so a failure here can never
    // affect the real setup pipeline, which has already fully committed by
    // this point.
    if (DEMO_POST_STAGES.includes(stage)) {
      try {
        const item = await generateDemoPost(scope, stage, intake);
        if (item) {
          await IdeaChatRepository.appendSetupDemoPost({
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            item,
          });
        }
      } catch (error) {
        console.error(
          "[project-setup-orchestrator] demo post generation failed:",
          error,
        );
      }
    }
  },
};
