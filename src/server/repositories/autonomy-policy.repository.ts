import "server-only";

import { prisma } from "@/lib/prisma";
import { AgentelseError } from "@/server/security/errors";

export type DailyCounterField =
  | "tasksCreated"
  | "reasoningCalls"
  | "signalsIngested"
  | "opportunitiesCreated"
  | "ideasCreated";

const COUNTER_TO_CAP: Record<
  DailyCounterField,
  | "maxTasksPerDay"
  | "maxReasoningCallsPerDay"
  | "maxOpenOpportunities"
  | "maxActiveIdeas"
  | null
> = {
  tasksCreated: "maxTasksPerDay",
  reasoningCalls: "maxReasoningCallsPerDay",
  signalsIngested: null,
  opportunitiesCreated: "maxOpenOpportunities",
  ideasCreated: "maxActiveIdeas",
};

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export const AutonomyPolicyRepository = {
  getForProject(projectId: string) {
    return prisma.autonomyPolicy.findUnique({ where: { projectId } });
  },

  getOrCreate(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
    setupAutoApprove?: boolean;
  }) {
    return prisma.autonomyPolicy.upsert({
      where: { projectId: scope.projectId },
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        setupAutoApprove: scope.setupAutoApprove ?? false,
      },
      // An explicitly given setupAutoApprove is also applied to an existing
      // policy — otherwise the setup form's preference would be ignored for
      // already-seeded projects.
      update:
        scope.setupAutoApprove === undefined
          ? {}
          : { setupAutoApprove: scope.setupAutoApprove },
    });
  },

  update(projectId: string, data: Record<string, unknown>) {
    return prisma.autonomyPolicy.update({
      where: { projectId },
      data: data as never,
    });
  },

  getTodayStat(projectId: string) {
    return prisma.agencyDailyStat.findUnique({
      where: { projectId_date: { projectId, date: todayUtc() } },
    });
  },

  // Atomic daily-cap gate: upsert-increment the counter, then compare against
  // the policy cap. Over cap -> decrement back and throw BUDGET_EXCEEDED, so
  // concurrent callers can never both slip under the same last slot.
  async checkAndIncrement(
    scope: { workspaceId: string; projectId: string; brandId: string },
    field: DailyCounterField,
    amount = 1,
    costUsd = 0,
  ): Promise<void> {
    const policy = await this.getOrCreate(scope);
    const date = todayUtc();

    const stat = await prisma.agencyDailyStat.upsert({
      where: { projectId_date: { projectId: scope.projectId, date } },
      create: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        date,
        [field]: amount,
        reasoningCostUsd: costUsd,
      },
      update: {
        [field]: { increment: amount },
        reasoningCostUsd: { increment: costUsd },
      },
    });

    // In unlimited mode the counter still increments (so the Activity view
    // and cost tracking stay accurate) but the threshold check is skipped.
    if (policy.unlimitedMode) return;

    const capField = COUNTER_TO_CAP[field];
    const cap = capField ? policy[capField] : null;
    const overCounter = cap !== null && stat[field] > cap;
    const overBudget =
      policy.dailyBudgetUsd !== null &&
      stat.reasoningCostUsd > policy.dailyBudgetUsd;

    if (overCounter || overBudget) {
      await prisma.agencyDailyStat.update({
        where: { projectId_date: { projectId: scope.projectId, date } },
        data: {
          [field]: { decrement: amount },
          reasoningCostUsd: { decrement: costUsd },
        },
      });
      throw new AgentelseError(
        "BUDGET_EXCEEDED",
        overBudget
          ? `Daily reasoning budget exceeded for project ${scope.projectId}`
          : `Daily cap ${String(capField)} exceeded for project ${scope.projectId}`,
        {
          // Which cap and where it stood — the chat's limit-notice card
          // renders these (see limit-notice.ts).
          meta: overBudget
            ? {
                limit: "dailyBudgetUsd",
                cap: policy.dailyBudgetUsd,
                used: stat.reasoningCostUsd,
              }
            : { limit: capField, cap, used: stat[field] },
        },
      );
    }
  },
};
