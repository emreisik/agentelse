import "server-only";

import { prisma } from "@/lib/prisma";
import { searchConsoleSiteCoversDomain } from "@/lib/search-console-site";
import { getSearchConsoleSite } from "@/server/integrations/search-console/sites";

import type { GscSyncContext } from "./context";
import { runGscSimple } from "./requests";

// Sitenin ayrıntıları günde bir (docs/google-search-console-plan.md §5,
// "metadata"): mülk türü (Domain / URL önekli), izin düzeyi ve sitenin
// projenin alan adını kapsayıp kapsamadığı. Otomatik marka terimleri aynı
// sıklıkla brandContextForLink'te tazelenir (runner).

export async function syncMetadata(ctx: GscSyncContext): Promise<void> {
  const site = await runGscSimple(ctx, () =>
    getSearchConsoleSite(ctx.accessToken, ctx.link.siteUrl),
  );
  const project = await prisma.project.findUnique({
    where: { id: ctx.link.projectId },
    select: { domain: true },
  });
  const domain = project?.domain ?? null;
  ctx.link = await prisma.gscSiteLink.update({
    where: { id: ctx.link.id },
    data: {
      propertyType: site.propertyType,
      permissionLevel: site.permissionLevel,
      domainMatch: domain
        ? searchConsoleSiteCoversDomain(ctx.link.siteUrl, domain)
        : null,
      lastMetadataAt: ctx.now,
    },
  });
}
