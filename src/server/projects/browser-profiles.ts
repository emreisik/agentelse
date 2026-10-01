import "server-only";

import { prisma } from "@/lib/prisma";
import { STANDARD_BROWSER_PROFILE_PURPOSES } from "@/server/projects/standard-browser-profiles";

// Standard browser-profile bundle (mirrors activateProjectAction/seed.ts).
// The rows record which connected accounts/purposes a project has; no
// external browser agent is bound to them (externalProfileId stays empty).
type ProjectScope = {
  workspaceId: string;
  projectId: string;
  brandId: string;
};

// Idempotent: creates the project's standard browser profiles only when it has
// none. Called by the setup orchestrator at INTAKE, and lazily by the
// capability router the first time a profile-bound capability runs for a
// project that skipped setup.
//
// Returns true when it created the profiles.
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
