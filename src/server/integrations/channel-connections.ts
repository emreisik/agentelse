import "server-only";

import { prisma } from "@/lib/prisma";
import type { ChannelConnections } from "@/lib/content-channels";
import { getPublishTargets } from "@/server/integrations/meta-connection-status";
import { META_PROVIDER } from "@/server/integrations/meta-client";

// Per planning channel: can the agency publish there right now? Built on the
// same source the creative card's "Share" section uses (getPublishTargets), so
// the plan never promises a destination that card would refuse. Blog/SEO is
// left out on purpose: there is nothing to connect, it is always a hand-off.
// Google Ads has no integration yet, so "ads" means the Meta Ads connection.
export async function getChannelConnections(
  projectId: string,
): Promise<ChannelConnections> {
  const [targets, metaAds] = await Promise.all([
    getPublishTargets(projectId),
    prisma.integrationCredential.findUnique({
      where: {
        projectId_provider: { projectId, provider: META_PROVIDER.ads },
      },
      select: { status: true, accountLabel: true },
    }),
  ]);

  const byPlatform = new Map(
    targets.map((target) => [target.platform, target]),
  );
  const instagram = byPlatform.get("instagram");
  const tiktok = byPlatform.get("tiktok");
  const linkedin = byPlatform.get("linkedin");
  const x = byPlatform.get("x");

  return {
    instagram: {
      connected: instagram !== undefined,
      accountLabel:
        instagram && "igUsername" in instagram && instagram.igUsername
          ? `@${instagram.igUsername}`
          : undefined,
    },
    tiktok: {
      connected: tiktok !== undefined,
      accountLabel:
        tiktok && "accountLabel" in tiktok ? tiktok.accountLabel : undefined,
    },
    linkedin: {
      connected: linkedin !== undefined,
      accountLabel:
        linkedin && "accountLabel" in linkedin
          ? linkedin.accountLabel
          : undefined,
    },
    x: {
      connected: x !== undefined,
      accountLabel: x && "accountLabel" in x ? x.accountLabel : undefined,
    },
    ads: {
      connected: metaAds?.status === "ACTIVE",
      accountLabel:
        metaAds?.status === "ACTIVE"
          ? (metaAds.accountLabel ?? undefined)
          : undefined,
    },
  };
}
