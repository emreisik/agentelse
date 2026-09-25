import "server-only";

import type { DepartmentKey } from "@prisma/client";

import { IdeaRepository } from "@/server/repositories/idea.repository";
import { IdeaChatRepository } from "@/server/repositories/idea-chat.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";

export type StrategicRequestScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

export type StrategicRequestResult =
  | { status: "CREATED"; ideaId: string }
  // Same "quietly declines" outcome IdeaFoundry.generateForOpportunity has
  // at the identical maxActiveIdeas gate — the caller (command-service.ts)
  // turns this into the existing limit-notice "active-ideas" card instead
  // of a raw thrown error, since this runs on the user-facing chat path.
  | { status: "CAPPED" };

// The Deep Path bridge (docs/brand-workspace-migration.md §7 Phase 8,
// spec: "Fast Path vs Deep Path" — a broad request like "enter the Russia
// market" should go through research+planning, not a single task).
//
// Deliberately builds NO new Council/WorkPlan orchestration: it creates a
// normal RAW Idea (status defaults to RAW — see IdeaRepository.create) and
// lets the ALREADY-REGISTERED autonomous tick steps
// (CouncilEngine.evaluatePendingIdeas -> AgencyDirector.decideShortlisted,
// agency-wiring.ts) carry it the rest of the way — through Council
// evaluation, SHORTLISTED, and a decided outcome (a single task, or, when
// `departments` has more than one entry, a real multi-department WorkPlan
// via WorkPlanBuilder) — with zero new pipeline code. A prior investigation
// this session confirmed a bare title/description/concept.departmentsInvolved
// idea has no precondition anywhere in that chain that would strand it
// (council-engine.ts never reads opportunityId or specific concept keys;
// the RAW->VALIDATED->CONCEPT->SHORTLISTED chain can complete inside a
// single tick).
//
// Mirrors IdeaFoundry.generateForOpportunity's exact safety-check shape
// (countActive gate BEFORE creating, checkAndIncrement AFTER) so a
// chat-triggered idea respects the SAME maxActiveIdeas cap an
// autonomously-generated one does — this is a new way ideas get created,
// so it must not bypass that budget.
export async function createStrategicIdea(
  scope: StrategicRequestScope,
  input: {
    title: string;
    description: string;
    departments?: DepartmentKey[];
  },
): Promise<StrategicRequestResult> {
  const policy = await AutonomyPolicyRepository.getOrCreate(scope);
  const activeIdeas = await IdeaRepository.countActive(scope.projectId);
  if (!policy.unlimitedMode && activeIdeas >= policy.maxActiveIdeas) {
    return { status: "CAPPED" };
  }

  const idea = await IdeaRepository.create({
    ...scope,
    title: input.title,
    description: input.description,
    concept:
      input.departments && input.departments.length > 0
        ? { departmentsInvolved: input.departments }
        : undefined,
  });

  await AutonomyPolicyRepository.checkAndIncrement(
    scope,
    "ideasCreated",
    1,
  ).catch(() => undefined);

  // Zero point of the idea's own chat thread — same convention
  // idea-foundry.ts uses for autonomously-generated ideas, so this reads
  // identically to one in the "Chats" sidebar / project-flow-view.
  await IdeaChatRepository.postSystemMessage({
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    ideaId: idea.id,
    text: `This looked like a bigger initiative, so I started a dedicated thread for it: **${input.title}**\n\n${input.description}`,
    card: {
      kind: "idea",
      title: input.title,
      description: input.description,
    },
  }).catch((error) => {
    console.error("[strategic-request] postSystemMessage failed:", error);
  });

  return { status: "CREATED", ideaId: idea.id };
}
