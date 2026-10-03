import "server-only";

import type { CreativeStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { buildBrandKit, type BrandKit } from "@/lib/brand-kit";
import type { ConnectedAccount } from "@/lib/connected-accounts";
import { loadConnectedAccounts } from "@/server/integrations/connected-accounts";
import { resolveBrandStyleContext } from "@/server/media/brand-style-context";
import { getBrandTwin, type BrandTwin } from "@/server/brand-twin/brand-twin";
import type { LibraryAsset } from "@/components/hub-core/panels/library-browser";

// Real counts behind the workspace root's "Resume where we left off" card
// (product spec's "Home/Dashboard" section) — deliberately just three status
// buckets, not a full breakdown, so it stays honest without a live feed:
// numbers only, no invented activity text.
export type WorkspaceResumeStats = {
  drafts: number;
  pendingApproval: number;
  approved: number;
};

export type WorkspaceRightPanelData = {
  brand: BrandTwin | null;
  // Everything visual about the brand for the Brand tab (logos in both
  // variants, role-labelled palette, fonts, style, post template).
  brandKit: BrandKit | null;
  website: string | null;
  // Where the project's accounts stand, for the Brand tab's "Bağlı hesaplar"
  // card.
  connections: ConnectedAccount[];
  resumeStats: WorkspaceResumeStats;
  files: LibraryAsset[];
  // The Calendar tab reads its own data client-side from the board's light
  // endpoint (calendar-panel.tsx); the page only hands it the project's
  // scheduling timezone so "today" matches the server's day keys.
  calendar: {
    timezone: string;
  };
};

// The brand's structured style data (both logo variants, role-split colours,
// photography style, template). BrandTwin deliberately carries only a flat
// summary of this, so the Brand tab reads it directly.
async function loadBrandStyle(projectId: string) {
  const brand = await prisma.brand.findFirst({
    where: { projectId, isDefault: true },
    select: { id: true },
  });
  return brand ? resolveBrandStyleContext(brand.id) : null;
}

// One Promise.all for the Brand Workspace right panel's server-fed tabs (Brand
// / Files; Outputs and Calendar read their own light endpoints client-side,
// see outputs-panel.tsx and calendar-panel.tsx) — same "one fetch, several cheap read models"
// shape as app-shell.tsx's getSidebarData, so the panel doesn't add a
// second request waterfall alongside the page's own root-branch fetch.
// getBrandTwin() runs its own internal composition (see brand-twin.ts) but
// is still just one more parallel branch here, not a second round-trip.
export const FILES_PANEL_LIMIT = 120;

export async function getWorkspaceRightPanelData(
  projectId: string,
): Promise<WorkspaceRightPanelData> {
  // The account card needs the project's website, so it chains off this query
  // inside the same Promise.all rather than waiting for the batch to finish.
  const projectPromise = prisma.project.findUnique({
    where: { id: projectId },
    select: { domain: true },
  });

  const [
    brand,
    project,
    connections,
    assets,
    schedule,
    statusCounts,
    brandStyle,
  ] = await Promise.all([
    getBrandTwin(projectId),
    projectPromise,
    projectPromise.then((row) =>
      loadConnectedAccounts(projectId, row?.domain ?? null),
    ),
    // The newest files only: every generated image lands here, and the whole
    // list is sent to the browser with the page. The full set is in Library.
    prisma.asset.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: FILES_PANEL_LIMIT,
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        createdAt: true,
        type: true,
      },
    }),
    prisma.projectSchedule.findFirst({
      where: { projectId, capability: "INSTAGRAM_PUBLISH" },
      select: { timezone: true },
    }),
    prisma.creative.groupBy({
      by: ["status"],
      where: { projectId },
      _count: { _all: true },
    }),
    loadBrandStyle(projectId),
  ]);

  const countFor = (statuses: CreativeStatus[]) =>
    statusCounts
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + row._count._all, 0);

  const brandKit = brand
    ? buildBrandKit({
        legacyColors: brand.visualDNA.colors,
        fonts: brand.visualDNA.fonts,
        logoAssetId: brandStyle?.logoAssetId ?? brand.visualDNA.logoAssetId,
        darkLogoAssetId: brandStyle?.darkLogoAssetId ?? null,
        identity: brandStyle?.visualIdentity ?? null,
      })
    : null;

  return {
    brand,
    brandKit,
    website: project?.domain ?? null,
    connections,
    resumeStats: {
      drafts: countFor(["DRAFT"]),
      pendingApproval: countFor(["IN_REVIEW"]),
      approved: countFor(["APPROVED", "PUBLISHED"]),
    },
    files: assets.map((asset) => ({
      ...asset,
      createdAt: asset.createdAt.toISOString(),
    })),
    calendar: {
      timezone: schedule?.timezone ?? "Europe/Istanbul",
    },
  };
}
