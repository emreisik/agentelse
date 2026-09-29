import "server-only";

import type { ProjectStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { AgencyLoopStateRepository } from "@/server/repositories/agency-loop-state.repository";
import { AuditLogRepository } from "@/server/repositories/audit-log.repository";
import { AutonomyPolicyRepository } from "@/server/repositories/autonomy-policy.repository";
import { ProjectRepository } from "@/server/repositories/project.repository";

// A project no longer has to finish the 12-stage setup before it can work:
// the chat agent acts straight away and Quick Discovery / Deep Brand
// Enrichment fill the brand context in as they go. "Ready to work" is now
// just Project.status === "ACTIVE", and this is the one place that gets a
// project there.
//
// The state machine forbids CREATED -> ACTIVE (state-machine/transitions.ts),
// so this walks the legal path. PAUSED and CLOSED are deliberately absent:
// those are decisions somebody made (pause the agency, close the project) and
// ensuring "active" must never undo them.
const PATH_TO_ACTIVE: Partial<Record<ProjectStatus, ProjectStatus[]>> = {
  CREATED: ["DISCOVERY", "PROFILE_REVIEW", "ACTIVE"],
  DISCOVERY: ["PROFILE_REVIEW", "ACTIVE"],
  NEEDS_INFORMATION: ["PROFILE_REVIEW", "ACTIVE"],
  PROFILE_REVIEW: ["ACTIVE"],
  NEEDS_ASSESSMENT: ["PROFILE_REVIEW", "ACTIVE"],
  STRATEGY: ["ACTIVE"],
};

// Enough steps for the longest path (CREATED) plus a lost race or two.
const MAX_STEPS = 6;

export type ProjectActivation = {
  status: ProjectStatus;
  // True when work may start: the project is ACTIVE. False for PAUSED/CLOSED
  // (or a project that vanished), which callers surface as "on hold".
  usable: boolean;
};

async function readProject(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      status: true,
      brands: {
        where: { isDefault: true },
        select: { id: true },
        take: 1,
      },
    },
  });
}

// Idempotent and cheap for an already-ACTIVE project (one read plus two
// upserts), so it is safe to call on every chat turn and command. A concurrent
// caller that wins a transition is fine: each step re-reads the status.
export async function ensureProjectActive(
  projectId: string,
): Promise<ProjectActivation> {
  let project = await readProject(projectId);
  if (!project) return { status: "CLOSED", usable: false };

  const startedAs = project.status;
  for (
    let step = 0;
    step < MAX_STEPS && project && project.status !== "ACTIVE";
    step += 1
  ) {
    const next = PATH_TO_ACTIVE[project.status]?.[0];
    // PAUSED / CLOSED: not ours to change.
    if (!next) break;
    try {
      await ProjectRepository.transition(projectId, project.workspaceId, next);
    } catch {
      // Lost a race with another caller, or the row changed under us. The
      // re-read below decides whether there is anything left to do.
    }
    project = await readProject(projectId);
  }

  if (!project) return { status: "CLOSED", usable: false };
  if (project.status !== "ACTIVE") {
    return { status: project.status, usable: false };
  }

  const brandId = project.brands[0]?.id;
  if (brandId) {
    const scope = { workspaceId: project.workspaceId, projectId, brandId };
    // The loop's daily budget and its status popover both read these rows;
    // setup used to be what created them.
    await Promise.all([
      AutonomyPolicyRepository.getOrCreate(scope),
      AgencyLoopStateRepository.getOrCreate(scope),
    ]);
    if (startedAs !== "ACTIVE") {
      await AuditLogRepository.record({
        workspaceId: project.workspaceId,
        projectId,
        brandId,
        actorType: "SYSTEM",
        action: "project.activated",
        entityType: "Project",
        entityId: projectId,
        metadata: { from: startedAs, via: "ensureProjectActive" },
      }).catch(() => undefined);
    }
  }

  return { status: "ACTIVE", usable: true };
}
