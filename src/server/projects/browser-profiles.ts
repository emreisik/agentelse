import "server-only";

import { prisma } from "@/lib/prisma";
import { provisionOpenClawAgent } from "@/server/execution/providers/openclaw/openclaw-agent-provisioner";
import { STANDARD_BROWSER_PROFILE_PURPOSES } from "@/server/projects/standard-browser-profiles";

// Standard browser-profile bundle (mirrors activateProjectAction/seed.ts).
// Deep-discovery and every public-web research task needs the PUBLIC_RESEARCH
// profile: without a profile row OpenClaw cannot serve those capabilities at
// all (OpenClawProvider.canExecute), and a task that resolved no profile falls
// back to the shared default agent, which has no browser skill (the
// 2026-09-15 SIGNAL_SCAN incident, see execution-policy.ts).
type ProjectScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Idempotent: creates the project's standard browser profiles (and its own
// OpenClaw agent) only when it has none. Called by the setup orchestrator at
// INTAKE, and lazily by the capability router the first time a browser
// capability runs for a project that skipped setup, so a project that starts
// working straight from the chat still gets its own research agent.
//
// Returns true when it created the profiles. A failed agent provisioning is
// not an error: externalProfileId stays empty and the job falls back to the
// default agent (openclaw-agent-provisioner.ts).
export async function ensureStandardBrowserProfiles(
  scope: ProjectScope,
): Promise<boolean> {
  const existing = await prisma.browserProfile.count({
    where: { projectId: scope.projectId },
  });
  if (existing > 0) return false;

  const projectRow = await prisma.project.findUniqueOrThrow({
    where: { id: scope.projectId },
    select: { slug: true },
  });
  // Without an OpenClaw agent for the project, profile slugs don't map to any
  // agent and real browser tasks fail with `Unknown agent id`.
  const externalProfileId =
    (await provisionOpenClawAgent(projectRow.slug)) ?? undefined;

  // skipDuplicates: two callers can both see zero profiles at once (@@unique
  // on projectId + slug); the loser must not throw.
  const result = await prisma.browserProfile.createMany({
    data: STANDARD_BROWSER_PROFILE_PURPOSES.map((purpose) => ({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      brandId: scope.brandId,
      name: `${projectRow.slug}-${purpose.toLowerCase()}`,
      slug: `${projectRow.slug}-${purpose.toLowerCase()}`,
      purpose,
      status: "READY" as const,
      externalProfileId,
    })),
    skipDuplicates: true,
  });
  return result.count > 0;
}

// Same, for a caller that only has the project id (the capability router).
// Returns false when the project or its default brand can't be found.
export async function ensureStandardBrowserProfilesForProject(
  projectId: string,
): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      workspaceId: true,
      brands: {
        where: { isDefault: true },
        select: { id: true },
        take: 1,
      },
    },
  });
  const brandId = project?.brands[0]?.id;
  if (!project || !brandId) return false;
  return ensureStandardBrowserProfiles({
    workspaceId: project.workspaceId,
    projectId,
    brandId,
  });
}
