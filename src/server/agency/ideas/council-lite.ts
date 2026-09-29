import "server-only";

import { isLegacyUnitEnabled } from "@/server/agency/legacy-loop";
import { IdeaRepository } from "@/server/repositories/idea.repository";

// "Council-lite": what replaces the LLM Council for a new idea once the legacy
// agency loop is wound down (LEGACY_AGENCY_LOOP=drain|off, legacy-loop.ts).
//
// The Council's whole effect on an idea it does not reject is to move it to
// SHORTLISTED (council-engine.ts), and everything downstream that a user can
// see hangs off that status: the Ideas panel's approve action and the weekly
// content planner Autopilot runs (it only draws from SHORTLISTED ideas). Two
// LLM calls per idea to decide that were not buying a better answer, so with
// the Council off a new idea is shortlisted directly; whether it is worth
// doing is the client's call (approving it) or the chat agent's.
//
// While the loop is fully on nothing changes: the Council picks the idea up on
// the next tick as before.
//
// Returns true when it shortlisted the idea.
export async function shortlistIfCouncilOff(
  ideaId: string,
  projectId: string,
): Promise<boolean> {
  if (isLegacyUnitEnabled("council-evaluation")) return false;
  try {
    await IdeaRepository.promoteToShortlist(ideaId, projectId);
    return true;
  } catch (error) {
    // The idea exists and is visible; a failed promotion just leaves it RAW,
    // which is exactly where the Council would have found it. Never fail the
    // creation over it.
    console.error(
      `[council-lite] failed to shortlist idea ${ideaId}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
