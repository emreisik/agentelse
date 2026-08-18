import "server-only";

import type { ActorType } from "@prisma/client";

import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { goalGenerationDef } from "@/server/reasoning/prompts/goal-generation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BaselineAuditRepository } from "@/server/repositories/baseline-audit.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";
import { AgentelseError } from "@/server/security/errors";

export type GenerateGoalsInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  brandName: string;
  description?: string;
};

export const GoalEngine = {
  // Proposes 3-6 goals from constitution + audits (spec section 12). Goals
  // start PROPOSED; approval is a separate step (client or SYSTEM auto).
  async generateForProject(input: GenerateGoalsInput) {
    const [brand, audits] = await Promise.all([
      ConstitutionService.getBrandContext(input.brandId),
      BaselineAuditRepository.listForProject(input.projectId),
    ]);

    const { output, isMock } = await ReasoningService.run(goalGenerationDef, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      context: {
        brandName: input.brandName,
        description: input.description,
        brand,
        audits: audits.map((a) => ({
          department: a.department,
          score: a.score,
          summary: a.summary,
        })),
      },
    });

    return ProjectGoalRepository.createMany(
      output.goals.map((goal) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        title: goal.title,
        description: goal.description,
        metricKey: goal.metricKey,
        priority: goal.priority,
        isMock,
      })),
    );
  },

  async approveAll(
    projectId: string,
    approvedByType: ActorType,
    approvedByUserId?: string,
  ) {
    const proposed = await ProjectGoalRepository.listForProject(projectId, {
      status: "PROPOSED",
    });
    for (const goal of proposed) {
      await ProjectGoalRepository.transition(goal.id, projectId, "APPROVED", {
        approvedByType,
        approvedByUserId,
      });
      await ProjectGoalRepository.transition(goal.id, projectId, "ACTIVE");
    }
    return proposed.length;
  },

  // Guard used by planners: every SYSTEM-created work item must serve >=1
  // goal (spec section 12: "Every automated work item must be linked to
  // at least one ProjectGoal").
  assertGoalsLinked(goalIds: string[], context: string): void {
    if (goalIds.length === 0) {
      throw new AgentelseError(
        "PERMISSION_DENIED",
        `Autonomous work must link at least one ProjectGoal (${context})`,
      );
    }
  },
};
