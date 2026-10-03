import "server-only";

import type { LearningPolarity } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  cleanReasons,
  creativeName,
  designDigestOf,
  ratingInsight,
  type CreativeRating,
} from "@/lib/creative-rating";
import { readLayoutMeta } from "@/server/media/creative-layout";

import {
  DEFAULT_CONFIDENCE,
  memorySourceOf,
  selectMemory,
  strongerSource,
  type MemoryItem,
  type MemorySource,
  type SelectedMemory,
} from "./relevance";

// Brand Memory: what the agency has learned about how THIS brand wants to be
// worked for, kept apart from Brand Core (who the brand is; the versioned
// constitution) and from the current conversation. One writer, one reader:
//
//  - remember(): the only way something enters memory. Every memory carries
//    where it came from and how sure we are, is stored once (seeing it again
//    reinforces it instead of adding a copy), and an AI guess never passes for
//    a fact.
//  - recall(): the memories that matter for what is being asked right now, not
//    the whole store.
//
// It lives in BrandLearning, which already had the columns (insight, polarity,
// sourceType, confidence, evidenceCount, lastReinforcedAt); the stated
// decisions that predate it (UserDecision) are read alongside so nothing the
// client already told us is lost.

export type MemoryScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type RememberResult = {
  status: "CREATED" | "REINFORCED" | "UNCHANGED" | "REJECTED";
  id?: string;
  // Opposite memories the client's own words replaced.
  superseded: number;
};

const MAX_INSIGHT_CHARS = 300;
// How much history recall looks at before selecting; enough for years of a
// normal brand, small enough to read in one query.
const RECALL_LEARNINGS = 300;
const RECALL_DECISIONS = 60;

// One line of plain text: no control characters, single spaces, bounded. What
// is stored is later shown to the model, so it must not carry markup that
// looks like structure.
export function cleanInsight(text: string): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ");
  const trimmed = flat.trim();
  return trimmed.length > MAX_INSIGHT_CHARS
    ? `${trimmed.slice(0, MAX_INSIGHT_CHARS).trimEnd()}…`
    : trimmed;
}

const opposite = (polarity: LearningPolarity): LearningPolarity =>
  polarity === "WORKS" ? "AVOID" : "WORKS";

// The label of a creative in a memory line.
function creativeLabel(creative: {
  title: string | null;
  channel: string | null;
  formatKey: string | null;
}): string | null {
  const title = creative.title?.trim();
  if (!title) return null;
  const where = creative.formatKey ?? creative.channel;
  return where ? `"${title}" (${where})` : `"${title}"`;
}

export const MemoryService = {
  async remember(input: {
    scope: MemoryScope;
    insight: string;
    polarity: LearningPolarity;
    source: MemorySource;
    // What it came from (a decision id, "creative:<id>"...), so a later reader
    // can tell which stored decision a memory already covers.
    sourceRef?: string;
    confidence?: number;
  }): Promise<RememberResult> {
    const insight = cleanInsight(input.insight);
    if (!insight) return { status: "REJECTED", superseded: 0 };
    const { scope, polarity, source } = input;
    const sameText = { equals: insight, mode: "insensitive" as const };

    // The client's own latest word wins: saying "avoid X" replaces an earlier
    // "X works", and the other way round. Reactions to outputs never override
    // what the client said.
    let superseded = 0;
    if (source === "USER_EXPLICIT" || source === "USER_CORRECTION") {
      const removed = await prisma.brandLearning.deleteMany({
        where: {
          brandId: scope.brandId,
          polarity: opposite(polarity),
          insight: sameText,
        },
      });
      superseded = removed.count;
    }

    const existing = await prisma.brandLearning.findFirst({
      where: { brandId: scope.brandId, polarity, insight: sameText },
    });

    if (existing) {
      // A model guessing the same thing again is not new evidence: only an
      // action of the client's (or a measurement) makes a memory stronger.
      if (source === "AI_INFERRED") {
        return { status: "UNCHANGED", id: existing.id, superseded };
      }
      const known = memorySourceOf(existing.sourceType);
      const winner = strongerSource(known, source);
      await prisma.brandLearning.update({
        where: { id: existing.id },
        data: {
          evidenceCount: { increment: 1 },
          lastReinforcedAt: new Date(),
          // A stronger source relabels the memory; a weaker one never
          // downgrades it.
          ...(winner === source && known !== source
            ? { sourceType: source }
            : {}),
          // Confidence only ever goes up on reinforcement.
          confidence: Math.max(
            existing.confidence ?? 0,
            input.confidence ?? DEFAULT_CONFIDENCE[source],
          ),
        },
      });
      return { status: "REINFORCED", id: existing.id, superseded };
    }

    const created = await prisma.brandLearning.create({
      data: {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        brandId: scope.brandId,
        insight,
        polarity,
        sourceType: source,
        sourceRef: input.sourceRef,
        confidence: input.confidence ?? DEFAULT_CONFIDENCE[source],
        evidenceCount: 1,
        lastReinforcedAt: new Date(),
      },
    });
    return { status: "CREATED", id: created.id, superseded };
  },

  // The client reacted to a finished creative. A hint about taste, not a rule:
  // one approval or one revision starts as a tentative memory and only becomes
  // confirmed when it keeps happening (relevance.ts isConfirmed). Never throws:
  // learning from a decision must not be able to break making the decision.
  async rememberCreativeReaction(input: {
    scope: MemoryScope;
    creativeId: string;
    outcome: "APPROVED" | "REJECTED" | "REVISION_REQUESTED";
    note?: string;
  }): Promise<RememberResult | null> {
    try {
      const creative = await prisma.creative.findFirst({
        where: { id: input.creativeId, projectId: input.scope.projectId },
        select: { title: true, channel: true, formatKey: true },
      });
      const label = creative ? creativeLabel(creative) : null;
      if (!label) return null;
      const sourceRef = `creative:${input.creativeId}`;

      if (input.outcome === "APPROVED") {
        return await MemoryService.remember({
          scope: input.scope,
          insight: `Client approved ${label}`,
          polarity: "WORKS",
          source: "OUTPUT_ACCEPTED",
          sourceRef,
        });
      }
      if (input.outcome === "REJECTED") {
        return await MemoryService.remember({
          scope: input.scope,
          insight: `Client rejected ${label}`,
          polarity: "AVOID",
          source: "OUTPUT_REJECTED",
          sourceRef,
        });
      }
      const note = input.note?.trim();
      if (!note) return null;
      return await MemoryService.remember({
        scope: input.scope,
        insight: `Client asked to change ${label}: ${note}`,
        polarity: "AVOID",
        source: "USER_CORRECTION",
        sourceRef,
      });
    } catch (error) {
      console.error(
        "[memory] could not record a creative reaction:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  },

  // The client rated a finished post (like / not quite, with what was wrong).
  // A deliberate verdict, so it is richer than an approval: the sentence names
  // what the post looked like and, for a dislike, what was wrong, and a second
  // verdict on the same post replaces the first. A like is a hint of taste (it
  // takes repetition to be confirmed); a dislike with a reason is a correction.
  // Never throws: rating must not be able to break the card it sits on.
  async rememberCreativeRating(input: {
    scope: MemoryScope;
    creativeId: string;
    rating: CreativeRating;
    reasons?: readonly unknown[];
    note?: string;
  }): Promise<RememberResult | null> {
    try {
      const creative = await prisma.creative.findFirst({
        where: { id: input.creativeId, projectId: input.scope.projectId },
        select: {
          title: true,
          channel: true,
          formatKey: true,
          brief: true,
          versions: {
            orderBy: { version: "desc" },
            take: 1,
            select: { generationMetadata: true },
          },
        },
      });
      if (!creative) return null;
      const name = creativeName(creative);
      if (!name) return null;
      const layout = readLayoutMeta(creative.versions[0]?.generationMetadata);
      const sourceRef = `creative:${input.creativeId}:rating`;
      // One verdict per post: the new one replaces the old.
      await prisma.brandLearning.deleteMany({
        where: { brandId: input.scope.brandId, sourceRef },
      });
      return await MemoryService.remember({
        scope: input.scope,
        insight: ratingInsight({
          rating: input.rating,
          name,
          digest: designDigestOf({ brief: creative.brief, layoutName: layout?.name }),
          reasons: cleanReasons(input.reasons ?? []),
          note: input.note,
        }),
        polarity: input.rating === "LIKE" ? "WORKS" : "AVOID",
        source: input.rating === "LIKE" ? "OUTPUT_ACCEPTED" : "USER_CORRECTION",
        sourceRef,
      });
    } catch (error) {
      console.error(
        "[memory] could not record a creative rating:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  },

  // What to put in front of the agent for this message: everything the client
  // explicitly told us (bounded), plus the best matches among the rest.
  async recall(
    brandId: string,
    query: string,
    now: Date = new Date(),
  ): Promise<SelectedMemory> {
    const [learnings, decisions] = await Promise.all([
      prisma.brandLearning.findMany({
        where: { brandId },
        orderBy: { createdAt: "desc" },
        take: RECALL_LEARNINGS,
      }),
      prisma.userDecision.findMany({
        where: { brandId },
        orderBy: { createdAt: "desc" },
        take: RECALL_DECISIONS,
      }),
    ]);

    const items: MemoryItem[] = learnings.map((row) => ({
      id: row.id,
      text: row.insight,
      polarity: row.polarity,
      source: memorySourceOf(row.sourceType),
      confidence: row.confidence,
      seen: row.evidenceCount,
      updatedAt: row.lastReinforcedAt ?? row.createdAt,
    }));

    // A stated decision that was also saved as a memory (remember_preference
    // writes both) is already in the list above; don't say it twice.
    const covered = new Set(
      learnings.flatMap((row) => (row.sourceRef ? [row.sourceRef] : [])),
    );
    for (const decision of decisions) {
      if (covered.has(decision.id)) continue;
      const value =
        typeof decision.value === "string"
          ? decision.value
          : JSON.stringify(decision.value);
      items.push({
        id: `decision:${decision.id}`,
        text:
          decision.scope && decision.scope !== "BRAND"
            ? `${value} (${decision.scope})`
            : value,
        polarity: "WORKS",
        source: "LEGACY_DECISION",
        confidence: null,
        seen: 1,
        updatedAt: decision.createdAt,
      });
    }

    return selectMemory(items, query, { now });
  },
};
