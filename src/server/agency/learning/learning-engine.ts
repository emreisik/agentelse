import "server-only";

import { prisma } from "@/lib/prisma";
import { learningExtractionDef } from "@/server/reasoning/prompts/learning-extraction";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";

// Measurement results -> BrandLearning entries (spec section 32). Learnings
// land in the existing Brand Brain model and flow into future execution
// context via ContextBuilder.
export const LearningEngine = {
  async processCompletedMeasurements(limit = 10): Promise<number> {
    // Completed plans whose learning hasn't been extracted yet (marker:
    // a BrandLearning with sourceRef = plan id).
    const plans = await prisma.measurementPlan.findMany({
      where: { status: "COMPLETED" },
      take: limit,
      orderBy: { updatedAt: "desc" },
      include: { checks: true },
    });

    let extracted = 0;
    for (const plan of plans) {
      // Paused-project guard (audit scenario L): silently skip — no
      // BrandLearning is written, so a resumed project's plan is simply
      // picked up again on a later tick.
      if (!(await isProjectAgencyActive(plan.projectId))) continue;
      const existing = await prisma.brandLearning.findFirst({
        where: { sourceType: "MEASUREMENT_PLAN", sourceRef: plan.id },
        select: { id: true },
      });
      if (existing) continue;

      const task = plan.taskId
        ? await prisma.task.findUnique({
            where: { id: plan.taskId },
            select: { title: true, capability: true },
          })
        : null;

      const { output, isMock } = await ReasoningService.run(
        learningExtractionDef,
        {
          workspaceId: plan.workspaceId,
          projectId: plan.projectId,
          brandId: plan.brandId,
          context: {
            work: {
              title: task?.title,
              capability: task?.capability,
              description: plan.description,
            },
            results: plan.checks.map((c) => ({
              label: c.label,
              status: c.status,
              summary: c.resultSummary,
            })),
          },
        },
      );

      for (const learning of output.learnings) {
        await prisma.brandLearning.create({
          data: {
            workspaceId: plan.workspaceId,
            projectId: plan.projectId,
            brandId: plan.brandId,
            insight: isMock ? `[MOCK] ${learning.insight}` : learning.insight,
            sourceType: "MEASUREMENT_PLAN",
            sourceRef: plan.id,
            confidence: learning.confidence,
          },
        });
      }
      extracted += 1;
    }

    return extracted;
  },
};
