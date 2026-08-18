import "server-only";

import type { ProjectStatus, SetupStage } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { BaselineAuditService } from "@/server/agency/audits/baseline-audit.service";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { DepartmentRouter } from "@/server/agency/departments/department-router";
import { GoalEngine } from "@/server/agency/goals/goal-engine";
import { SignalProfileService } from "@/server/agency/signals/signal-profile.service";
import { TaskPlanner } from "@/server/commands/task-planner";
import { provisionOpenClawAgent } from "@/server/execution/providers/openclaw/openclaw-agent-provisioner";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ProjectRepository } from "@/server/repositories/project.repository";
import {
  SetupStateRepository,
  nextStage,
} from "@/server/repositories/setup-state.repository";
import { SignalProfileRepository } from "@/server/repositories/signal-profile.repository";
import { nextScanAt } from "@/server/agency/signals/scan-cadence";

import {
  DEEP_DISCOVERY_CAPABILITIES,
  DISCOVERY_COMPLETION_RATIO,
  discoveryResearchRequest,
} from "./setup-stages";

export type SetupIntake = {
  brandName: string;
  domain?: string;
  description?: string;
  assetIds?: string[];
  autoApprove?: boolean;
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

const TERMINAL_TASK_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

// Standard browser-profile bundle (mirrors activateProjectAction/seed.ts).
// Provisioned at INTAKE because deep-discovery research tasks need the
// PUBLIC_RESEARCH profile long before PROJECT_ACTIVATION.
const STANDARD_BROWSER_PROFILE_PURPOSES = [
  "PUBLIC_RESEARCH",
  "INSTAGRAM",
  "TIKTOK",
  "META_ADS",
  "GOOGLE_ADS",
  "LINKEDIN",
] as const;


// Aktivasyon yalnızca PROFILE_REVIEW'dan ACTIVE'e geçiyordu. Proje başka bir
// ara durumdaysa (örneğin kaldırılan eski sihirbazdan kalma
// NEEDS_INFORMATION) geçiş sessizce atlanıyor, kurulum "aktive edildi"
// görünüyor ama proje ACTIVE olmuyordu — sürekli ajans döngüsü ve sinyal
// taramaları ACTIVE şartı aradığı için sistem hiç çalışmıyordu.
// Durum makinesindeki yasal yolu adım adım yürüyerek ACTIVE'e ulaşıyoruz.
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
    await ProjectRepository.transition(scope.projectId, scope.workspaceId, next);
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

    const existingProfiles = await prisma.browserProfile.count({
      where: { projectId: scope.projectId },
    });
    if (existingProfiles === 0) {
      const projectRow = await prisma.project.findUniqueOrThrow({
        where: { id: scope.projectId },
        select: { slug: true },
      });
      // Projeye ait OpenClaw ajanı olmadan profil slug'ları hiçbir ajana
      // karşılık gelmez ve gerçek tarayıcı görevleri `Unknown agent id`
      // ile düşer. Ajan açılamazsa externalProfileId boş kalır ve iş
      // varsayılan ajana düşer — kurulum yine de ilerler.
      const externalProfileId =
        (await provisionOpenClawAgent(projectRow.slug)) ?? undefined;

      await prisma.browserProfile.createMany({
        data: STANDARD_BROWSER_PROFILE_PURPOSES.map((purpose) => ({
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          brandId: scope.brandId,
          name: `${projectRow.slug}-${purpose.toLowerCase()}`,
          slug: `${projectRow.slug}-${purpose.toLowerCase()}`,
          purpose,
          status: "READY" as const,
          externalProfileId,
        })),
      });
    }

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
      await SetupStateRepository.transitionStage(projectId, stage, "RUNNING");
      await this.runStage(scope, intake, stage);
      return { stage, status: "RUNNING", advanced: true };
    }

    if (record.status === "RUNNING") {
      const complete = await this.isStageComplete(scope, stage);
      if (!complete) return { stage, status: "RUNNING", advanced: false };

      const waits = await this.stageWaitsForClient(scope, intake, stage);
      if (waits) {
        await SetupStateRepository.transitionStage(
          projectId,
          stage,
          "WAITING_CLIENT",
        );
        return { stage, status: "WAITING_CLIENT", advanced: true };
      }

      await this.completeStage(scope, stage);
      return { stage, status: "COMPLETED", advanced: true };
    }

    if (record.status === "WAITING_CLIENT") {
      // Stays parked until submitClientDecision flips it.
      return { stage, status: "WAITING_CLIENT", advanced: false };
    }

    if (record.status === "FAILED") {
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

  // Worker entry: advance all unfinished setups, several steps each so a
  // single tick can walk synchronous stages without waiting a tick per stage.
  async advanceAll(limit = 5): Promise<number> {
    const states = await SetupStateRepository.listUnfinished(limit);
    let advanced = 0;
    for (const state of states) {
      // Bounded inner loop: keep stepping while progress is being made.
      for (let i = 0; i < 6; i += 1) {
        const result = await this.advance(state.projectId);
        if (result.advanced) advanced += 1;
        else break;
      }
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

    await this.completeStage(scope, stage);
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
          const wave = DEEP_DISCOVERY_CAPABILITIES.slice(
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
        { error: error instanceof Error ? error.message : String(error) },
      );
      throw error;
    }
  },

  async isStageComplete(
    scope: SetupScope,
    stage: SetupStage,
  ): Promise<boolean> {
    if (stage === "DEEP_DISCOVERY") {
      const tasks = await prisma.task.findMany({
        where: {
          projectId: scope.projectId,
          createdByType: "SYSTEM",
          capability: { in: DEEP_DISCOVERY_CAPABILITIES },
        },
        select: { status: true },
      });
      if (tasks.length === 0) return false;
      const terminal = tasks.filter((t) =>
        (TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status),
      );
      const completed = tasks.filter((t) => t.status === "COMPLETED");
      return (
        terminal.length / tasks.length >= DISCOVERY_COMPLETION_RATIO &&
        completed.length >= 1
      );
    }
    // Every other stage runs synchronously inside runStage.
    return true;
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

  async completeStage(scope: SetupScope, stage: SetupStage): Promise<void> {
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
  },
};
