import "server-only";

import { prisma } from "@/lib/prisma";
import { siteDomainsOf } from "@/lib/utm";

// Projenin kendi siteleri: Project.domain ile birincil GA bağının akış
// adresinin sunucusu (alt alan adları isOwnSiteUrl'de sayılır). İki okuma
// paralel koşar; proje yoksa boş döner.
export async function projectSiteDomains(projectId: string): Promise<string[]> {
  const [project, link] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    }),
    prisma.gaPropertyLink.findFirst({
      where: { projectId, isPrimary: true },
      orderBy: { updatedAt: "desc" },
      select: { streamUri: true },
    }),
  ]);
  if (!project) return [];
  return siteDomainsOf({
    projectDomain: project.domain,
    streamUri: link?.streamUri ?? null,
  });
}
