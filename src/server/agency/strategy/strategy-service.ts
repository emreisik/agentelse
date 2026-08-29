import "server-only";

import { prisma } from "@/lib/prisma";
import { strategySynthesisDef } from "@/server/reasoning/prompts/strategy-synthesis";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { BrandConstitutionRepository } from "@/server/repositories/brand-constitution.repository";
import { BrandDecisionRepository } from "@/server/repositories/brand-decision.repository";
import { BrandStrategyRepository } from "@/server/repositories/brand-strategy.repository";
import { ProjectGoalRepository } from "@/server/repositories/project-goal.repository";

import { BrandStrategyPayloadSchema } from "./strategy-schema";

export type SynthesizeInput = {
  workspaceId: string;
  projectId: string;
  brandId: string;
  brandName: string;
};

const RECENT_LEARNINGS_LIMIT = 20;

// Synthesizes the next Brand Strategy version from the active Constitution,
// the project's active goals, and recent BrandLearning entries — the
// forward-looking counterpart to ConstitutionService (see
// constitution-service.ts, which this mirrors structurally).
export const StrategyEngine = {
  async synthesize(input: SynthesizeInput) {
    const [constitution, goals, learnings] = await Promise.all([
      BrandConstitutionRepository.getActive(input.brandId),
      ProjectGoalRepository.listActiveOrApproved(input.projectId),
      prisma.brandLearning.findMany({
        where: { brandId: input.brandId },
        orderBy: { createdAt: "desc" },
        take: RECENT_LEARNINGS_LIMIT,
        select: { insight: true, confidence: true },
      }),
    ]);

    const { output, isMock } = await ReasoningService.run(
      strategySynthesisDef,
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
        context: {
          brandName: input.brandName,
          constitutionSummary: constitution?.summary ?? undefined,
          goals: goals.map((g) => ({
            title: g.title,
            description: g.description,
            priority: g.priority,
          })),
          learnings,
        },
      },
    );

    const payload = BrandStrategyPayloadSchema.parse(output);

    const version = await BrandStrategyRepository.createNextVersion({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      payload,
      summary: payload.summary,
    });

    await BrandStrategyRepository.setCurrentVersion(
      {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        brandId: input.brandId,
      },
      version.id,
    );

    await BrandDecisionRepository.record({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      brandId: input.brandId,
      topic: "Brand Strategy",
      decision: `v${version.version} activated`,
      rationale: payload.summary,
      decidedByType: isMock ? "AI" : "SYSTEM",
    });

    return version;
  },

  // Brands with an active Constitution that have accumulated at least one
  // BrandLearning since their last strategy version (or never had one) —
  // bounded scan, breaks as soon as `limit` due brands are found.
  async projectsNeedingStrategy(limit = 5): Promise<SynthesizeInput[]> {
    const activeConstitutions = await prisma.brandConstitution.findMany({
      where: { status: "ACTIVE" },
      select: { brandId: true, projectId: true, workspaceId: true },
    });

    const due: SynthesizeInput[] = [];
    for (const c of activeConstitutions) {
      const latestVersion = await BrandStrategyRepository.getLatest(c.brandId);
      const hasNewLearning = await prisma.brandLearning.findFirst({
        where: {
          brandId: c.brandId,
          ...(latestVersion
            ? { createdAt: { gt: latestVersion.createdAt } }
            : {}),
        },
        select: { id: true },
      });
      if (!hasNewLearning) continue;

      const brand = await prisma.brand.findUnique({
        where: { id: c.brandId },
        select: { name: true },
      });
      due.push({ ...c, brandName: brand?.name ?? "Unknown brand" });
      if (due.length >= limit) break;
    }
    return due;
  },

  async resynthesizeDue(limit = 5): Promise<number> {
    const due = await StrategyEngine.projectsNeedingStrategy(limit);
    let synthesized = 0;
    for (const scope of due) {
      try {
        await StrategyEngine.synthesize(scope);
        synthesized += 1;
      } catch (error) {
        console.error(
          `[strategy-service] synthesize failed for brand ${scope.brandId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return synthesized;
  },
};
