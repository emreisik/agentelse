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
    if (policies.length === 0) return 0;

    // Set-based: this runs on every worker tick, and one read + one write per
    // project (three round trips each, in a row) grew with every project.
    const [projects, states] = await Promise.all([
      prisma.project.findMany({
        where: { id: { in: policies.map((policy) => policy.projectId) } },
        select: { id: true, status: true },
      }),
      AgencyLoopStateRepository.statusesFor(policies),
    ]);
    const paused = new Set(
      projects.flatMap((project) =>
        project.status === "PAUSED" ? [project.id] : [],
      ),
    );

    const toPause: string[] = [];
    const toResume: string[] = [];
    const toTouch: string[] = [];
    for (const { projectId } of policies) {
      const state = states.get(projectId);
      if (paused.has(projectId)) {
        if (state !== "PAUSED") toPause.push(projectId);
      } else if (state === "PAUSED") {
        // Un-paused since the last heartbeat — resume as RUNNING; a later
        // phase's no-progress circuit breaker can still move it to WAITING
        // on its own if there's genuinely nothing to do.
        toResume.push(projectId);
      } else {
        toTouch.push(projectId);
      }
    }

    await Promise.all([
      toPause.length > 0
        ? AgencyLoopStateRepository.setPausedMany(toPause, "Project is paused")
        : undefined,
      toResume.length > 0
        ? AgencyLoopStateRepository.resumeFromPauseMany(toResume)
        : undefined,
      toTouch.length > 0
        ? AgencyLoopStateRepository.touchMany(toTouch)
        : undefined,
    ]);
    return policies.length;
  },
};
