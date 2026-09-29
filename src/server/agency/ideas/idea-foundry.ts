import "server-only";

import type { CreativeLens, Opportunity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { MetaAdsQuery } from "@/server/integrations/meta-ads-query";
import { ideaGenerationDef } from "@/server/reasoning/prompts/idea-generation";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { IdeaRepository } from "@/server/repositories/idea.repository";
import { OpportunityRepository } from "@/server/repositories/opportunity.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";

import {
  FOCUS_LENS_MIX,
  isAgencyFocusMode,
} from "@/server/agency/agency-focus";
import { shortlistIfCouncilOff } from "./council-lite";
import { DEFAULT_LENS_MIX, LENS_DEFINITIONS } from "./creative-lenses";

// Bounds audit scenario K's opportunity retry so a repeatedly-failing
// concept can't regenerate ideas forever — 3 total attempts (the original
// plus two retries) before the opportunity is dismissed for good.
const MAX_IDEA_ATTEMPTS_PER_OPPORTUNITY = 3;

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
    opts?: {
      lenses?: CreativeLens[];
      // User-driven revision (reviseIdeaAction, agency-strategy-actions.ts):
      // when set, the prompt is told explicitly what was rejected and why,
      // instead of generating a fresh idea blind to the fact this lens was
      // already tried and didn't land.
      feedback?: string;
      priorIdea?: { title: string; description: string };
      // False only for INITIAL_IDEA_PORTFOLIO (agency-wiring.ts) — the
      // one-time onboarding batch shouldn't flood a brand-new project's chat
      // with "idea generated" cards before the client has even seen the
      // place. Idea/Opportunity records, council eligibility and the
      // ACCEPTED transition below are all unaffected; only the chat
      // messages (this idea's own card and its origin lineage) are skipped.
      // Every other caller (the chat "generate ideas" command, the
      // scheduled weekly run) keeps the default (post to chat).
      postToChat?: boolean;
    },
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

    const requestedLenses =
      opts?.lenses ?? (isAgencyFocusMode() ? FOCUS_LENS_MIX : DEFAULT_LENS_MIX);
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

    // For a performance-driven opportunity (see meta-performance-scanner.ts
    // — Track 1 feeds "performance" signals through this same
    // Insight->Opportunity chain), ground the idea generation in real,
    // fresh Meta Ads numbers instead of letting the LLM guess at what
    // "performance" means. Nothing else needs to change — buildPrompt()
    // already serializes context.opportunity as-is, so this extra field
    // just shows up. Best-effort: a Meta API hiccup here must not block
    // idea generation for every other opportunity category.
    const performanceContext =
      opportunity.category === "PERFORMANCE"
        ? await MetaAdsQuery.performanceSnapshotForProject(
            opportunity.projectId,
          ).catch(() => null)
        : null;

    const { output, isMock } = await ReasoningService.run(ideaGenerationDef, {
      ...scope,
      context: {
        brand,
        opportunity: {
          title: opportunity.title,
          description: opportunity.description,
          category: opportunity.category,
          ...(performanceContext ? { performanceContext } : {}),
        },
        lenses,
        ...(opts?.feedback
          ? { revision: { priorIdea: opts.priorIdea, feedback: opts.feedback } }
          : {}),
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
      // With the LLM Council wound down (LEGACY_AGENCY_LOOP=drain|off) the
      // idea is shortlisted right here; a no-op while the loop is fully on.
      await shortlistIfCouncilOff(createdIdea.id, projectId);

      if (opts?.postToChat !== false) {
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
  async generateForTopOpportunities(
    limit = 3,
    // projectId: on-demand callers (a chat request, a project's own
    // weekly/monthly GENERATE_IDEAS schedule — see command-service.ts,
    // scheduler-service.ts) scope this to their one project. Without it,
    // `distinct: ["projectId"]` below would collapse every result down to
    // at most 1 row regardless of `limit`, since a single-project query has
    // only one distinct projectId to begin with — so it's dropped in that
    // case rather than left in place.
    opts?: { projectId?: string },
  ): Promise<number> {
    const { prisma } = await import("@/lib/prisma");
    const candidates = await prisma.opportunity.findMany({
      where: {
        status: "EVALUATED",
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        // Eligible for a fresh attempt when it has no idea yet, OR every
        // idea it already produced ended up ARCHIVED/REJECTED (audit
        // scenario K: work-plan-progressor.ts's reconcilePlan archives an
        // idea whose WorkPlan failed — without this, the original
        // `ideas: { none: {} }` filter permanently excluded that
        // opportunity from ever getting a retry).
        ideas: { none: { status: { notIn: ["ARCHIVED", "REJECTED"] } } },
      },
      orderBy: [{ nbaScore: "desc" }, { createdAt: "asc" }],
      ...(opts?.projectId ? {} : { distinct: ["projectId"] }),
      take: limit,
      include: { _count: { select: { ideas: true } } },
    });
    let total = 0;
    for (const opportunity of candidates) {
      // Paused project — skip without processing, exactly like
      // signal-universe.ts's own scan skip. Try again next tick.
      if (!(await isProjectAgencyActive(opportunity.projectId))) continue;

      // Retry cap (audit scenario K, "no uncontrolled task generation"): an
      // opportunity that has already exhausted its attempts is dismissed
      // outright rather than left to match this query forever with nothing
      // to show for it — every existing idea is already ARCHIVED/REJECTED
      // at this point, so DISMISSED is a genuine give-up, not a duplicate
      // of either.
      if (opportunity._count.ideas >= MAX_IDEA_ATTEMPTS_PER_OPPORTUNITY) {
        try {
          await OpportunityRepository.transition(
            opportunity.id,
            opportunity.projectId,
            "DISMISSED",
          );
        } catch (error) {
          console.error(
            `[idea-foundry] failed to dismiss exhausted opportunity ${opportunity.id} (${opportunity.title}):`,
            error instanceof Error ? error.message : error,
          );
        }
        continue;
      }

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
