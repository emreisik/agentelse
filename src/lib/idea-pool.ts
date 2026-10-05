import type { IdeaStatus } from "@prisma/client";

// The idea pool (Ideas panel, the chat's planner, the Brand Brain loop): which
// statuses count as "waiting to be planned" and which as "already planned".
// APPROVED is an idea the person put forward; plans pick those first.

export const IDEA_POOL_STATUSES = [
  "RAW",
  "RESEARCHING",
  "VALIDATED",
  "CONCEPT",
  "SHORTLISTED",
  "APPROVED",
] as const satisfies readonly IdeaStatus[];

export const IDEA_PLANNED_STATUSES = [
  "PLANNING",
  "ACTIVE",
  "MEASURING",
] as const satisfies readonly IdeaStatus[];

// The label a plan item gets when it came from the pool ("From: Idea pool").
export const IDEA_POOL_LABEL = "Idea pool";

export function isPoolStatus(status: IdeaStatus): boolean {
  return (IDEA_POOL_STATUSES as readonly IdeaStatus[]).includes(status);
}

// Opens the chat and asks it to plan this idea (the page reads `planIdea`,
// checks the idea belongs to the project and sends the request once).
export function ideaPlanHref(projectId: string, ideaId: string): string {
  return `/projects/${projectId}?planIdea=${encodeURIComponent(ideaId)}`;
}
