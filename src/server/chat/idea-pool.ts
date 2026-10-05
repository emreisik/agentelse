import "server-only";

import { prisma } from "@/lib/prisma";
import { IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { IdeaRepository } from "@/server/repositories/idea.repository";

// The idea pool as the chat sees it: the ideas a content plan draws from first
// (works-notes.ts says how). Put-forward ideas (APPROVED) lead, then the
// shortlisted ones, then the rest, newest first.

export type PromptIdea = {
  id: string;
  title: string;
  summary: string;
  putForward?: true;
};

const POOL_SIZE = 12;
const SUMMARY_LENGTH = 180;

const RANK: Partial<Record<string, number>> = { APPROVED: 0, SHORTLISTED: 1 };

// Never throws: [] when there is nothing or the read failed.
export async function loadIdeaPoolForPrompt(
  projectId: string,
): Promise<PromptIdea[]> {
  try {
    const ideas = await prisma.idea.findMany({
      // Mock-mode ideas (the dev DB is shared) never reach a real plan.
      where: {
        projectId,
        status: { in: [...IDEA_POOL_STATUSES] },
        isMock: false,
      },
      orderBy: { createdAt: "desc" },
      take: 60,
      select: { id: true, title: true, description: true, status: true },
    });
    return ideas
      .map((idea, index) => ({ idea, index }))
      .sort(
        (a, b) =>
          (RANK[a.idea.status] ?? 2) - (RANK[b.idea.status] ?? 2) ||
          a.index - b.index,
      )
      .slice(0, POOL_SIZE)
      .map(({ idea }) => ({
        id: idea.id,
        title: idea.title,
        summary: idea.description
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, SUMMARY_LENGTH),
        ...(idea.status === "APPROVED" ? { putForward: true as const } : {}),
      }));
  } catch (error) {
    console.error("[idea-pool] read failed:", error);
    return [];
  }
}

// The ids among `ids` that are pool ideas of this project: what a plan item
// may name. Anything else (an id the model made up, another project's idea, an
// idea already planned or archived) is dropped by the caller.
export async function poolIdeaIds(
  projectId: string,
  ids: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await prisma.idea.findMany({
    where: {
      projectId,
      id: { in: unique },
      status: { in: [...IDEA_POOL_STATUSES] },
      isMock: false,
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

// A saved plan used these ideas: they leave the pool ("Planned"). Best-effort,
// one idea at a time, so one idea that cannot move never blocks the others.
export async function markIdeasPlanned(
  projectId: string,
  ideaIds: readonly string[],
): Promise<void> {
  for (const ideaId of new Set(ideaIds)) {
    await IdeaRepository.advanceForScheduling(ideaId, projectId).catch(
      (error: unknown) => {
        console.error(
          `[idea-pool] could not mark idea ${ideaId} planned:`,
          error,
        );
      },
    );
  }
}
