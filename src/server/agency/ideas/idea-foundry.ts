import "server-only";

import type { CreativeLens, Opportunity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { ideaGenerationDef } from "@/server/reasoning/prompts/idea-generation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

import { DEFAULT_LENS_MIX, LENS_DEFINITIONS } from "./creative-lenses";

// Also shows what came BEFORE the idea's "zero point" in the chat: writes
// the Signal(s)/Finding(s)/Insight+Opportunity chain that produced this idea
// (Opportunity.insightId -> Insight.{signalIds,findingIds}) using their OWN
// real creation timestamps, in chronological order BEFORE the idea message.
// If there's no chain (a manually created idea with no opportunity), it's
// silently skipped. Best-effort — failing to write an origin message must
// never block the idea-creation flow.
async function postOriginLineage(
  scope: { workspaceId: string; projectId: string },
  opportunity: Opportunity,
  ideaId: string,
) {
  if (!opportunity.insightId) return;
  const insight = await prisma.insight.findUnique({
    where: { id: opportunity.insightId },
  });
  if (!insight) return;

  const [signals, findings] = await Promise.all([
    prisma.signal.findMany({
      where: { id: { in: insight.signalIds } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.finding.findMany({
      where: { id: { in: insight.findingIds } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  for (const signal of signals) {
    await IdeaChatRepository.postSystemMessage({
      ...scope,
      ideaId,
      text: `📡 Signal detected: **${signal.title}**${signal.summary ? `\n\n${signal.summary}` : ""}`,
      card: {
        kind: "signal",
        title: signal.title,
        summary: signal.summary ?? undefined,
      },
      createdAt: signal.createdAt,
    });
  }

  for (const finding of findings) {
    await IdeaChatRepository.postSystemMessage({
      ...scope,
      ideaId,
      text: `🔍 Finding: ${finding.statement}`,
      card: {
        kind: "finding",
        title: finding.category ?? "Finding",
        statement: finding.statement,
      },
      createdAt: finding.createdAt,
    });
  }

  await IdeaChatRepository.postSystemMessage({
    ...scope,
    ideaId,
    text: `✨ Insight/Opportunity: **${opportunity.title}**${opportunity.description ? `\n\n${opportunity.description}` : ""}`,
    card: {
      kind: "insight-opportunity",
      title: opportunity.title,
      summary: insight.summary,
      description: opportunity.description ?? undefined,
    },
    createdAt: opportunity.createdAt,
  });
}

// Opportunity -> multiple diverse Ideas (spec sections 19-21). One reasoning
// call generates one idea per lens; per-(opportunity, lens) soft dedup stops
// repeat generation.
export const IdeaFoundry = {
  async generateForOpportunity(
    opportunityId: string,
    projectId: string,
    opts?: { lenses?: CreativeLens[] },
  ): Promise<number> {
    const opportunity = await OpportunityRepository.findByIdInProject(
      opportunityId,
      projectId,
    );
    if (!opportunity) return 0;

    const scope = {
      workspaceId: opportunity.workspaceId,
      projectId: opportunity.projectId,
      brandId: opportunity.brandId,
    };

    const policy = await AutonomyPolicyRepository.getOrCreate(scope);
    const activeIdeas = await IdeaRepository.countActive(projectId);
    if (!policy.unlimitedMode && activeIdeas >= policy.maxActiveIdeas) return 0;

    const requestedLenses = opts?.lenses ?? DEFAULT_LENS_MIX;
    const lenses: CreativeLens[] = [];
    for (const lens of requestedLenses) {
      const exists = await IdeaRepository.existsForOpportunityLens(
        opportunityId,
        lens,
      );
      if (!exists) lenses.push(lens);
    }
    if (lenses.length === 0) return 0;

    const brand = await ConstitutionService.getBrandContext(
      opportunity.brandId,
    );

    const { output, isMock } = await ReasoningService.run(ideaGenerationDef, {
      ...scope,
      context: {
        brand,
        opportunity: {
          title: opportunity.title,
          description: opportunity.description,
          category: opportunity.category,
        },
        lenses,
      },
    });

    let created = 0;
    for (const idea of output.ideas) {
      const lens = lenses.find((l) => l === idea.lens) ?? lenses[0];
      if (!lens || !(lens in LENS_DEFINITIONS)) continue;
      const createdIdea = await IdeaRepository.create({
        ...scope,
        opportunityId,
        lens,
        title: idea.title,
        description: idea.description,
        concept: idea.concept,
        isMock,
      });
      created += 1;

      // Write what came BEFORE the idea's "zero point" in the chat (Signal/
      // Finding/Insight+Opportunity, with their own real timestamps) BEFORE
      // the idea message, so the chat opens in chronological order. Best-effort.
      await postOriginLineage(scope, opportunity, createdIdea.id).catch(
        (error) => {
          console.error("[idea-foundry] postOriginLineage failed:", error);
        },
      );

      // This is the zero point of the idea's chat thread: every subsequent
      // pipeline step (council, work plan, task/creative) accumulates under
      // the same ideaId as a continuation of this message. Even if the
      // write fails, the idea-creation flow must not stop.
      await IdeaChatRepository.postSystemMessage({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ideaId: createdIdea.id,
        text: `💡 New idea generated: **${idea.title}**\n\n${idea.description}`,
        card: {
          kind: "idea",
          title: idea.title,
          description: idea.description,
        },
      }).catch((error) => {
        console.error("[idea-foundry] postSystemMessage failed:", error);
      });
    }

    if (created > 0) {
      await AutonomyPolicyRepository.checkAndIncrement(
        scope,
        "ideasCreated",
        created,
      ).catch(() => undefined);
      if (opportunity.status === "EVALUATED") {
        await OpportunityRepository.transition(
          opportunityId,
          projectId,
          "ACCEPTED",
        );
      }
    }

    return created;
  },

  // NBA-ranked EVALUATED opportunities without ideas get a generation pass.
  // nbaScore is never actually populated on Opportunity (only on Idea, by
  // agency-director.ts — see the grep, there is no writer for
  // Opportunity.nbaScore anywhere), so this always degenerates to a single
  // system-wide FIFO-by-createdAt queue. A project with an old backlog (154
  // opportunities from a project created 10 days earlier, in one incident)
  // then permanently starves every other project, including a brand-new
  // one, from ever getting an idea generated. `distinct: ["projectId"]`
  // picks at most one candidate per project instead, so `limit` slots are
  // spread fairly across whichever projects actually have a backlog.
  async generateForTopOpportunities(limit = 3): Promise<number> {
    const { prisma } = await import("@/lib/prisma");
    const candidates = await prisma.opportunity.findMany({
      where: { status: "EVALUATED", ideas: { none: {} } },
      orderBy: [{ nbaScore: "desc" }, { createdAt: "asc" }],
      distinct: ["projectId"],
      take: limit,
    });
    let total = 0;
    for (const opportunity of candidates) {
      // Per-opportunity error boundary: one opportunity that fails to
      // generate an idea must not also block every OTHER project's
      // opportunity in the same batch.
      try {
        total += await this.generateForOpportunity(
          opportunity.id,
          opportunity.projectId,
        );
      } catch (error) {
        console.error(
          `[idea-foundry] generateForOpportunity failed for opportunity ${opportunity.id} (${opportunity.title}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    return total;
  },
};
