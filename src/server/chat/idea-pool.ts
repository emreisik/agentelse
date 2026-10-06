import "server-only";

import { prisma } from "@/lib/prisma";
import { IDEA_POOL_LABEL, IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import {
  captionIdeaOf,
  isExpired,
  parseIdeaConcept,
  type SocialIdeaConcept,
} from "@/lib/ideas/concept";
import { foldForMatch } from "@/lib/text-fold";
import type { PlanAlternative } from "@/lib/works/plan-alternatives";
import { IdeaRepository } from "@/server/repositories/idea.repository";

// The idea pool as the chat sees it: the ideas a content plan draws from first
// (works-notes.ts says how). Put-forward ideas (APPROVED) lead, then the post
// ideas of the Ideas board (docs/ideas.md), strongest first, then the older
// shortlisted ones, then the rest, newest first. Article and ad ideas are not
// here: their modules start them, a content plan cannot use them.

export type PromptIdea = {
  id: string;
  title: string;
  summary: string;
  putForward?: true;
  // A post idea of the Ideas board is already written as a post: its
  // `captionIdea` is the plan item's, word for word ('"headline" | visual |
  // caption'), and `channels` are where it fits.
  captionIdea?: string;
  channels?: string[];
};

const POOL_SIZE = 12;
const SUMMARY_LENGTH = 180;

type PoolRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  concept: unknown;
};

type RankedIdea = {
  row: PoolRow;
  post: SocialIdeaConcept | null;
  index: number;
};

// Read newest first; ideas whose time has passed and ideas for other modules
// are left out. Mock-mode ideas (the dev DB is shared) never reach a real plan.
async function readPool(projectId: string, now: Date): Promise<RankedIdea[]> {
  const rows: PoolRow[] = await prisma.idea.findMany({
    where: {
      projectId,
      status: { in: [...IDEA_POOL_STATUSES] },
      isMock: false,
    },
    orderBy: { createdAt: "desc" },
    take: 80,
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      concept: true,
    },
  });
  return rows.flatMap((row, index): RankedIdea[] => {
    const concept = parseIdeaConcept(row.concept);
    if (!concept) return [{ row, post: null, index }];
    if (concept.module !== "social" || isExpired(concept, now)) return [];
    return [{ row, post: concept, index }];
  });
}

function rankOf(entry: RankedIdea): number {
  if (entry.row.status === "APPROVED") return 0;
  if (entry.post) return 1;
  return entry.row.status === "SHORTLISTED" ? 2 : 3;
}

function byRank(a: RankedIdea, b: RankedIdea): number {
  return (
    rankOf(a) - rankOf(b) ||
    (b.post?.strength ?? 0) - (a.post?.strength ?? 0) ||
    a.index - b.index
  );
}

function summaryOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_LENGTH);
}

// Never throws: [] when there is nothing or the read failed.
export async function loadIdeaPoolForPrompt(
  projectId: string,
  now: Date = new Date(),
): Promise<PromptIdea[]> {
  try {
    const pool = await readPool(projectId, now);
    return pool
      .sort(byRank)
      .slice(0, POOL_SIZE)
      .map(({ row, post }) => ({
        id: row.id,
        title: post ? post.draft.hook : row.title,
        summary: summaryOf(post ? (post.why ?? "") : row.description),
        ...(row.status === "APPROVED" ? { putForward: true as const } : {}),
        ...(post
          ? {
              captionIdea: captionIdeaOf(post.draft),
              channels: [...post.draft.channels],
            }
          : {}),
      }));
  } catch (error) {
    console.error("[idea-pool] read failed:", error);
    return [];
  }
}

// "New idea" on a plan's post (the plan alternatives route): the pool's post
// ideas no post of the plan uses or offers yet, best first, the ones drafted
// for the post's channel before the others. Each is the plan item it would
// be, linked to its idea. Never throws: [] when there is none.
export async function poolAlternativesFor(input: {
  projectId: string;
  channel?: string;
  // Ideas the plan already uses or offers.
  exclude: ReadonlySet<string>;
  // Topics on the plan: an idea with the same hook is not offered again.
  takenTopics: readonly string[];
  limit: number;
  now?: Date;
}): Promise<PlanAlternative[]> {
  if (input.limit <= 0) return [];
  try {
    const taken = new Set(
      input.takenTopics.map((topic) => foldForMatch(topic.trim())),
    );
    const fits = (entry: RankedIdea) =>
      !input.channel ||
      (entry.post?.draft.channels as readonly string[] | undefined)?.includes(
        input.channel,
      )
        ? 0
        : 1;
    const pool = await readPool(input.projectId, input.now ?? new Date());
    return pool
      .flatMap((entry) =>
        entry.post &&
        !input.exclude.has(entry.row.id) &&
        !taken.has(foldForMatch(entry.post.draft.hook.trim()))
          ? [{ ...entry, post: entry.post }]
          : [],
      )
      .sort((a, b) => fits(a) - fits(b) || byRank(a, b))
      .slice(0, input.limit)
      .map(({ row, post }) => ({
        topic: post.draft.hook,
        captionIdea: captionIdeaOf(post.draft),
        from: IDEA_POOL_LABEL,
        ideaId: row.id,
        origin: { kind: "idea" as const, ref: row.id },
      }));
  } catch (error) {
    console.error("[idea-pool] alternatives read failed:", error);
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
