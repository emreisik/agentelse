import type { PanelKey } from "./hub-core-params";

// The counts the sidebar and the Advanced menu put on their entries, derived
// from the project's nav badge data (app-shell.tsx reads it once) instead of a
// separate query each.
export type ToolBadgeCounts = {
  setupWaitingClient: number;
  pendingHumanActions: number;
  proposedGoals: number;
  proposedHandoffs: number;
  awaitingPlans: number;
};

export function toolBadgesFrom(
  counts: ToolBadgeCounts | null,
): Partial<Record<PanelKey, number>> {
  if (!counts) return {};
  const badges: Partial<Record<PanelKey, number>> = {};
  if (counts.setupWaitingClient > 0) {
    badges.setup = counts.setupWaitingClient;
  }
  // Goals are a Brand Brain tab: goals waiting for the client's decision light
  // the Brand Brain entry.
  if (counts.proposedGoals > 0) {
    badges["brand-brain"] = counts.proposedGoals;
  }
  const workBadge = counts.proposedHandoffs + counts.awaitingPlans;
  if (workBadge > 0) badges.work = workBadge;
  if (counts.pendingHumanActions > 0) {
    badges["human-action"] = counts.pendingHumanActions;
  }
  return badges;
}
