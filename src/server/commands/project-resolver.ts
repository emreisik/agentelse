import "server-only";

import { prisma } from "@/lib/prisma";

export type ProjectResolution =
  | { status: "RESOLVED"; projectId: string; brandId: string }
  | { status: "AMBIGUOUS"; candidates: { projectId: string; name: string }[] }
  | { status: "NOT_FOUND" };

// Rule-based project resolution: matches the project's name/slug as a
// case-insensitive substring of the raw command text. Good enough for the
// "Biduniq için..." style commands in spec section 7 — swap for an
// LLM-assisted resolver later without touching CommandService.
export async function resolveProjectFromText(
  workspaceId: string,
  rawText: string,
): Promise<ProjectResolution> {
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    include: { brands: { where: { isDefault: true }, take: 1 } },
  });

  // Plain toLowerCase(), not toLocaleLowerCase("tr-TR") — see the comment in
  // intent-router.ts on why the Turkish locale breaks ASCII brand names.
  const normalized = rawText.toLowerCase();
  const matches = projects.filter(
    (project) =>
      normalized.includes(project.name.toLowerCase()) ||
      normalized.includes(project.slug.toLowerCase()),
  );

  if (matches.length === 1) {
    const project = matches[0];
    const brandId = project?.brands[0]?.id;
    if (project && brandId) {
      return { status: "RESOLVED", projectId: project.id, brandId };
    }
  }

  if (matches.length > 1) {
    return {
      status: "AMBIGUOUS",
      candidates: matches.map((project) => ({
        projectId: project.id,
        name: project.name,
      })),
    };
  }

  return { status: "NOT_FOUND" };
}
