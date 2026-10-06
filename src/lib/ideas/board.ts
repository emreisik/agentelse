// The Ideas board's read model (docs/ideas.md): what one card needs, and the
// pure rules for which tab a card sits in, what the filters keep and how the
// board sorts. Isomorphic: the panel builds it on the server, the board
// filters and sorts it in the browser, the tests read it directly.

import type { IdeaStatus } from "@prisma/client";

import {
  isExpired,
  strengthOf,
  type IdeaConcept,
  type IdeaModule,
  type IdeaSource,
} from "@/lib/ideas/concept";
import { IDEA_PLANNED_STATUSES, IDEA_POOL_STATUSES } from "@/lib/idea-pool";
import { foldForMatch } from "@/lib/text-fold";

export type BoardStatus =
  "fresh" | "saved" | "planned" | "done" | "expired" | "archived";

export const BOARD_STATUSES: readonly BoardStatus[] = [
  "fresh",
  "saved",
  "planned",
  "done",
  "archived",
];

export type BoardSort = "best" | "newest" | "ending";

// Where the idea went after the board: a chat holding its post draft, a
// planned or published post.
export type IdeaLink = {
  workId?: string;
  scheduledFor?: string;
  published?: boolean;
};

export type BoardIdea = {
  id: string;
  status: IdeaStatus;
  // ISO strings: the board is a client component.
  createdAt: string;
  title: string;
  description: string;
  concept: IdeaConcept | null;
  link?: IdeaLink;
};

export type BoardFilters = {
  module: IdeaModule | "all" | "untyped";
  status: BoardStatus;
  source: IdeaSource | "all";
  channel: string | "all";
  query: string;
};

export const DEFAULT_FILTERS: BoardFilters = {
  module: "all",
  status: "fresh",
  source: "all",
  channel: "all",
  query: "",
};

const POOL: ReadonlySet<IdeaStatus> = new Set(IDEA_POOL_STATUSES);
const PLANNED: ReadonlySet<IdeaStatus> = new Set(IDEA_PLANNED_STATUSES);

export function boardStatusOf(idea: BoardIdea, now: Date): BoardStatus {
  if (idea.status === "APPROVED") return "saved";
  if (POOL.has(idea.status)) {
    return isExpired(idea.concept, now) ? "expired" : "fresh";
  }
  if (PLANNED.has(idea.status)) return "planned";
  if (idea.status === "LEARNED") return "done";
  return "archived";
}

// "Expired" ideas are filed under Archived: out of the way, not gone.
function inTab(status: BoardStatus, tab: BoardStatus): boolean {
  if (tab === "archived") return status === "archived" || status === "expired";
  return status === tab;
}

function searchable(idea: BoardIdea): string {
  const c = idea.concept;
  const parts = [idea.title, idea.description];
  if (c?.module === "social") {
    parts.push(c.draft.headline, c.draft.visual, c.draft.pillar ?? "");
  } else if (c?.module === "seo") {
    parts.push(c.draft.keyword, c.draft.title);
  } else if (c?.module === "ads") {
    parts.push(c.draft.angle);
  }
  return foldForMatch(parts.join(" "));
}

export function filterIdeas(
  ideas: readonly BoardIdea[],
  filters: BoardFilters,
  now: Date,
): BoardIdea[] {
  const query = foldForMatch(filters.query.trim());
  return ideas.filter((idea) => {
    if (!inTab(boardStatusOf(idea, now), filters.status)) return false;
    const kind = idea.concept?.module ?? "untyped";
    if (filters.module !== "all" && kind !== filters.module) return false;
    if (filters.source !== "all" && idea.concept?.source !== filters.source) {
      return false;
    }
    if (filters.channel !== "all") {
      const c = idea.concept;
      if (c?.module !== "social") return false;
      if (!c.draft.channels.includes(filters.channel as never)) return false;
    }
    if (query && !searchable(idea).includes(query)) return false;
    return true;
  });
}

function expiresAtOf(idea: BoardIdea): number {
  const at = idea.concept?.expiresAt
    ? Date.parse(idea.concept.expiresAt)
    : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

export function sortIdeas(
  ideas: readonly BoardIdea[],
  sort: BoardSort,
): BoardIdea[] {
  const newest = (a: BoardIdea, b: BoardIdea) =>
    b.createdAt.localeCompare(a.createdAt);
  const copy = [...ideas];
  if (sort === "newest") return copy.sort(newest);
  if (sort === "ending") {
    return copy.sort((a, b) => expiresAtOf(a) - expiresAtOf(b) || newest(a, b));
  }
  // Best first: saved ideas lead, then typed ideas by strength, then newest;
  // older untyped ideas come last.
  return copy.sort((a, b) => {
    const saved =
      Number(b.status === "APPROVED") - Number(a.status === "APPROVED");
    if (saved) return saved;
    const typed = Number(b.concept !== null) - Number(a.concept !== null);
    if (typed) return typed;
    return strengthOf(b.concept) - strengthOf(a.concept) || newest(a, b);
  });
}

export function countByStatus(
  ideas: readonly BoardIdea[],
  now: Date,
): Record<BoardStatus, number> {
  const counts: Record<BoardStatus, number> = {
    fresh: 0,
    saved: 0,
    planned: 0,
    done: 0,
    expired: 0,
    archived: 0,
  };
  for (const idea of ideas) {
    const status = boardStatusOf(idea, now);
    counts[status === "expired" ? "archived" : status] += 1;
  }
  return counts;
}

export function countByModule(
  ideas: readonly BoardIdea[],
): Record<IdeaModule | "untyped", number> {
  const counts = { social: 0, seo: 0, ads: 0, untyped: 0 };
  for (const idea of ideas) counts[idea.concept?.module ?? "untyped"] += 1;
  return counts;
}

// Fresh ideas of a module: what the pool refill counts against its target.
export function freshCount(
  ideas: readonly BoardIdea[],
  module: IdeaModule,
  now: Date,
): number {
  return ideas.filter(
    (idea) =>
      idea.concept?.module === module && boardStatusOf(idea, now) === "fresh",
  ).length;
}
