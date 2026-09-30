import "server-only";

import type { ChannelConnections } from "@/lib/content-channels";
import type { GoalMode, HandsOn } from "@/lib/guided-setup/contract";
import { legacyAgencyLoopMode } from "@/server/agency/legacy-loop";
import { getChannelConnections } from "@/server/integrations/channel-connections";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";

// How Approve would write the setup's goal (spec 9.6). An ACTIVE goal is what
// lets the legacy Director act on waiting ideas, and autopilot creates,
// schedules and publishes on its own, so a goal saved by a few taps could start
// autonomous work. That combination (legacy loop on, autopilot, at least one
// connected channel) makes the goal a PROPOSAL the person approves in Strategy;
// everything else writes it as an active, user-approved goal.
//
// Reads only. The service and the Server Action import this file; apply.ts must
// not (it receives the resolver by injection, guard G35).

export type GoalModeResolution = {
  mode: GoalMode;
  // AutonomyPolicy.autopilotMode, read-only, for the Review line. null = unknown.
  handsOn: HandsOn | null;
};

export async function resolveGoalMode(
  projectId: string,
  deps: { connections?: ChannelConnections } = {},
): Promise<GoalModeResolution> {
  try {
    const [policy, connections] = await Promise.all([
      AutonomyPolicyRepository.getForProject(projectId),
      deps.connections ?? getChannelConnections(projectId),
    ]);
    // No policy row yet: the schema default applies, which is AUTOPILOT.
    const handsOn: HandsOn = policy?.autopilotMode ?? "AUTOPILOT";
    const anyConnected = Object.values(connections).some(
      (connection) => connection?.connected === true,
    );
    const mayStartWork =
      legacyAgencyLoopMode() === "on" &&
      handsOn === "AUTOPILOT" &&
      anyConnected;
    return { mode: mayStartWork ? "proposed" : "active", handsOn };
  } catch (error) {
    // Fail safe: an unknown state must never turn into an active goal.
    console.error(
      "[guided-setup] goal mode unknown, proposing the goal:",
      error instanceof Error ? error.message : error,
    );
    return { mode: "proposed", handsOn: null };
  }
}
