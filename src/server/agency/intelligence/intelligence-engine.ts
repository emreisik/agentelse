import "server-only";

import { insightFingerprint } from "@/server/agency/fingerprint";
import { isAgentelseError } from "@/server/security/errors";
import { ConstitutionService } from "@/server/agency/constitution/constitution-service";
import { insightSynthesisDef } from "@/server/reasoning/prompts/insight-synthesis";
import { signalRelevanceDef } from "@/server/reasoning/prompts/signal-relevance";
import { ReasoningService } from "@/server/reasoning/reasoning-service";
import { isProjectAgencyActive } from "@/server/repositories/agency-loop-state.repository";
import { FindingRepository } from "@/server/repositories/finding.repository";
import { InsightRepository } from "@/server/repositories/insight.repository";
import { SignalRepository } from "@/server/repositories/signal.repository";

import { FindingWriter } from "./finding-writer";

// RAW SIGNAL -> NORMALIZE -> DEDUPLICATE -> RELEVANCE SCORE -> FINDING ->
// INSIGHT (spec section 17). Dedup already happened at ingest (fingerprint
// unique); this engine scores NEW signals and synthesizes insights from
// promoted ones.
const SCORING_CONCURRENCY = 5;

// The step serves every client at once. Taking simply the oldest `limit` signals
// lets one client with a pile of old ones (or one whose AI budget is spent, whose
// signals therefore never leave NEW) fill every tick and starve the rest. Signals
// are picked one client at a time in turn instead, oldest first within a client.
const CANDIDATE_POOL_FACTOR = 5;

export function fairShare<T extends { workspaceId: string }>(
  rows: readonly T[],
  limit: number,
): T[] {
  const queues = new Map<string, T[]>();
  for (const row of rows) {
    const queue = queues.get(row.workspaceId) ?? [];
    queue.push(row);
    queues.set(row.workspaceId, queue);
  }
  const picked: T[] = [];
  while (picked.length < limit && queues.size > 0) {
    for (const [workspaceId, queue] of queues) {
      picked.push(queue.shift()!);
      if (queue.length === 0) queues.delete(workspaceId);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

export const IntelligenceEngine = {
  async processNewSignals(limit = 20): Promise<number> {
    const signals = fairShare(
      await SignalRepository.listNewForScoring(limit * CANDIDATE_POOL_FACTOR),
      limit,
    );
    let processed = 0;
    // Clients whose AI budget (daily cap or plan allowance) stopped a call in
    // THIS run: their remaining signals wait, everybody else's go on. A budget
    // stop is the client's own limit working, not the step's. The stalled client's
    // whole backlog is moved to the back of the queue, so it cannot fill the head
    // of the next tick as well.
    const stalled = new Set<string>();

    // One independent LLM relevance call per signal — scored in bounded
    // parallel chunks instead of strictly one after another (20 sequential
    // calls used to dominate the tick). Any other thrown error still ends the
    // step like before.
    const scoreOne = async (signal: (typeof signals)[number]) => {
      if (stalled.has(signal.workspaceId)) return;
      try {
        await scoreSignal(signal);
      } catch (error) {
        if (isAgentelseError(error) && error.code === "BUDGET_EXCEEDED") {
          if (!stalled.has(signal.workspaceId)) {
            stalled.add(signal.workspaceId);
            await SignalRepository.deferWorkspace(signal.workspaceId);
          }
          return;
        }
        throw error;
      }
    };
    const scoreSignal = async (signal: (typeof signals)[number]) => {
      // Paused project — push forward without processing, exactly like
      // signal-universe.ts's own scan skip. Try again next tick.
      if (!(await isProjectAgencyActive(signal.projectId))) return;

      const brand = await ConstitutionService.getBrandContext(signal.brandId);
      const { output } = await ReasoningService.run(signalRelevanceDef, {
        workspaceId: signal.workspaceId,
        projectId: signal.projectId,
        brandId: signal.brandId,
        context: {
          brand,
          signal: {
            title: signal.title,
            summary: signal.summary,
            category: signal.category,
            source: signal.source,
          },
        },
      });

      await SignalRepository.transition(signal.id, signal.projectId, "SCORED", {
        relevanceScore: output.relevanceScore,
      });

      if (output.shouldPromote) {
        await SignalRepository.transition(
          signal.id,
          signal.projectId,
          "PROMOTED",
        );
        // Promoted signal becomes a Finding so the intelligence corpus stays
        // unified for constitution/audits/insights.
        await FindingWriter.writeMany(
          {
            workspaceId: signal.workspaceId,
            projectId: signal.projectId,
            brandId: signal.brandId,
          },
          [
            {
              sourceType: "SIGNAL",
              signalId: signal.id,
              category: signal.category.toLowerCase(),
              statement: `${signal.title}${signal.summary ? ` — ${signal.summary}` : ""}`,
              classification: "LIKELY_FACT",
              confidence:
                (signal.reliability ?? 0.5) * (output.relevanceScore / 100),
              isMock: ReasoningService.isMockMode(),
            },
          ],
        );
      } else {
        await SignalRepository.transition(
          signal.id,
          signal.projectId,
          "DISCARDED",
        );
      }
      processed += 1;
    };

    for (let i = 0; i < signals.length; i += SCORING_CONCURRENCY) {
      await Promise.all(
        signals.slice(i, i + SCORING_CONCURRENCY).map(scoreOne),
      );
    }

    return processed;
  },

  // Synthesizes insights for one project from its promoted-but-unconsumed
  // signals + recent findings. Insight dedup via fingerprint unique.
  async synthesizeInsights(scope: {
    workspaceId: string;
    projectId: string;
    brandId: string;
  }): Promise<number> {
    const [signals, findings, brand] = await Promise.all([
      SignalRepository.listForProject(scope.projectId, {
        status: "PROMOTED",
        limit: 30,
      }),
      FindingRepository.listForProject(scope.projectId, { limit: 60 }),
      ConstitutionService.getBrandContext(scope.brandId),
    ]);

    if (signals.length === 0 && findings.length === 0) return 0;

    const items = [
      ...signals.map((s) => ({
        kind: "signal" as const,
        id: s.id,
        title: s.title,
        category: s.category,
      })),
      ...findings.slice(0, 40).map((f) => ({
        kind: "finding" as const,
        id: f.id,
        statement: f.statement,
        category: f.category ?? "general",
      })),
    ];

    const { output, isMock } = await ReasoningService.run(insightSynthesisDef, {
      ...scope,
      context: { brand, items },
    });

    let created = 0;
    for (const insight of output.insights) {
      const related = insight.relatedIndexes
        .map((i) => items[i])
        .filter((item): item is (typeof items)[number] => Boolean(item));
      const result = await InsightRepository.create({
        ...scope,
        title: insight.title,
        summary: insight.summary,
        category: related.find((r) => r.kind === "signal")
          ? signals.find(
              (s) => s.id === related.find((r) => r.kind === "signal")?.id,
            )?.category
          : undefined,
        findingIds: related
          .filter((r) => r.kind === "finding")
          .map((r) => r.id),
        signalIds: related.filter((r) => r.kind === "signal").map((r) => r.id),
        importance: insight.importance,
        fingerprint: insightFingerprint({ title: insight.title }),
        isMock,
      });
      if (!result.duplicate) created += 1;
    }

    return created;
  },

  // Projects with material (a promoted signal or a finding) newer than their
  // last synthesis attempt. Every attempt is one LLM call, so "newer than the
  // last attempt" is what keeps a project from being re-synthesized on every
  // tick from the same promoted signals (PROMOTED is final: they never leave
  // the pool). Comparing against the last ATTEMPT, not the last insight, also
  // covers a run whose insights were all duplicates. The longest-waiting
  // projects go first, so a few projects can't starve the rest.
  async projectsNeedingInsights(limit = 5, now: Date = new Date()) {
    const { prisma } = await import("@/lib/prisma");

    const [bySignal, byFinding] = await Promise.all([
      prisma.signal.groupBy({
        by: ["workspaceId", "projectId", "brandId"],
        where: { status: "PROMOTED" },
        _max: { updatedAt: true },
      }),
      prisma.finding.groupBy({
        by: ["workspaceId", "projectId", "brandId"],
        _max: { createdAt: true },
      }),
    ]);

    const newest = new Map<
      string,
      { workspaceId: string; projectId: string; brandId: string; at: Date }
    >();
    const note = (
      group: { workspaceId: string; projectId: string; brandId: string },
      at: Date | null | undefined,
    ) => {
      if (!at) return;
      const known = newest.get(group.projectId);
      if (!known || at > known.at) {
        newest.set(group.projectId, {
          workspaceId: group.workspaceId,
          projectId: group.projectId,
          brandId: group.brandId,
          at,
        });
      }
    };
    for (const group of bySignal) note(group, group._max.updatedAt);
    for (const group of byFinding) note(group, group._max.createdAt);
    if (newest.size === 0) return [];

    const lastAttempts = await prisma.reasoningCall.findMany({
      where: {
        purpose: insightSynthesisDef.purpose,
        projectId: { in: [...newest.keys()] },
      },
      orderBy: { createdAt: "desc" },
      distinct: ["projectId"],
      select: { projectId: true, createdAt: true, status: true },
    });
    const lastAttemptOf = new Map(
      lastAttempts.map((call) => [call.projectId, call] as const),
    );

    const due = [...newest.values()]
      .map((material) => ({
        material,
        lastAttempt: lastAttemptOf.get(material.projectId) ?? null,
      }))
      .filter(({ material, lastAttempt }) =>
        needsInsightSynthesis(material.at, lastAttempt, now),
      )
      .sort(
        (a, b) =>
          (a.lastAttempt?.createdAt.getTime() ?? 0) -
          (b.lastAttempt?.createdAt.getTime() ?? 0),
      )
      .slice(0, limit)
      .map(({ material }) => ({
        workspaceId: material.workspaceId,
        projectId: material.projectId,
        brandId: material.brandId,
      }));

    // This candidate list is dispatched 1:1 into synthesizeInsights(scope)
    // by the tick step wiring (agency-wiring.ts), one call per project, with
    // no further filtering there — so a paused-project candidate must be
    // dropped here to keep that dispatch from ever seeing it. Same silent
    // "try again next tick" behavior as signal-universe.ts's own skip.
    const activeFlags = await Promise.all(
      due.map((candidate) => isProjectAgencyActive(candidate.projectId)),
    );
    return due.filter((_, index) => activeFlags[index]);
  },
};

// A failed attempt is retried after this long even without new material, so
// one transient error doesn't strand what is already there.
const FAILED_SYNTHESIS_RETRY_MS = 60 * 60_000;

// Whether a project's newest material still needs a synthesis run.
export function needsInsightSynthesis(
  newestMaterialAt: Date,
  lastAttempt: { createdAt: Date; status: string } | null,
  now: Date,
): boolean {
  if (!lastAttempt) return true;
  if (newestMaterialAt > lastAttempt.createdAt) return true;
  return (
    lastAttempt.status !== "OK" &&
    now.getTime() - lastAttempt.createdAt.getTime() > FAILED_SYNTHESIS_RETRY_MS
  );
}
