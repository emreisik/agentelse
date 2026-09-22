import "server-only";

import { prisma } from "@/lib/prisma";
import { AgencyLoopStateRepository } from "@/server/repositories/agency-loop-state.repository";

// Keeps AgencyLoopState fresh for every onboarded project (has an
// AutonomyPolicy — the same "is this project actually running the agency"
// proxy used elsewhere, e.g. signal-universe.ts), independent of whether a
// trigger fired for it this tick. This is what makes Project.status =
// PAUSED actually visible as a loop status: previously the ONLY engine
// that ever checked Project.status was SignalUniverse.runDueScans — every
// other engine (idea generation, council, director decisions, work-plan
// progression, measurement, learning) kept running against a "paused"
// project's existing backlog regardless. Full enforcement (every engine
// actually refusing to act on a paused project) is a later phase; this is
// the shared state those checks will read.
export const AgencyLoopHeartbeat = {
  async run(limit = 50): Promise<number> {
    const policies = await prisma.autonomyPolicy.findMany({
      take: limit,
      select: { workspaceId: true, projectId: true, brandId: true },
    });

    let touched = 0;
    for (const policy of policies) {
      const project = await prisma.project.findUnique({
        where: { id: policy.projectId },
        select: { status: true },
      });
      const state = await AgencyLoopStateRepository.getOrCreate(policy);

      if (project?.status === "PAUSED") {
        if (state.status !== "PAUSED") {
          await AgencyLoopStateRepository.setPaused(
            policy.projectId,
            "Project is paused",
          );
        }
      } else if (state.status === "PAUSED") {
        // Un-paused since the last heartbeat — resume as RUNNING; a later
        // phase's no-progress circuit breaker can still move it to WAITING
        // on its own if there's genuinely nothing to do.
        await AgencyLoopStateRepository.resumeFromPause(policy.projectId);
      } else {
        await AgencyLoopStateRepository.touch(policy.projectId);
      }
      touched += 1;
    }
    return touched;
  },
};
